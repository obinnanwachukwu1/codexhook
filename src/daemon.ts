import type http from "node:http";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  DEFAULT_HOST,
  SHUTDOWN_GRACE_MS,
  databasePath,
} from "./config.js";
import { Delivery, DeliveryLive } from "./delivery/delivery.js";
import { Logger } from "./logger.js";
import { WebhookRegistry } from "./registry.js";
import {
  closeCodexhookServer,
  listen,
} from "./server.js";
import type { RequestAuthenticator } from "./service/auth.js";
import { ServiceLifecycle } from "./service/lifecycle.js";
import {
  AppServerTasks,
  AppServerTasksLive,
} from "./service/local-tasks.js";
import { TransportProviderLive } from "./transport/provider.js";
import {
  CodexTransport,
  makeCodexTransportLive,
} from "./transport/transport.js";

type DaemonRuntime = ManagedRuntime.ManagedRuntime<
  Delivery | CodexTransport | AppServerTasks,
  never
>;

export interface UnifiedDaemonOptions {
  readonly port: number;
  readonly dataDirectory: string;
  readonly host?: string | undefined;
  readonly shutdownGraceMs?: number | undefined;
  readonly logger?: Logger | undefined;
  readonly authenticator?: RequestAuthenticator | undefined;
}

export interface UnifiedDaemon {
  readonly server: http.Server;
  readonly stop: (reason?: string) => Promise<void>;
}

function makeRuntime(logger: Logger): DaemonRuntime {
  const transport = makeCodexTransportLive(logger);
  const deliveryAndTransport = DeliveryLive(logger).pipe(
    Layer.provideMerge(transport),
  );
  const services = Layer.merge(
    deliveryAndTransport,
    AppServerTasksLive(),
  ).pipe(Layer.provide(TransportProviderLive(logger)));
  return ManagedRuntime.make(services);
}

export async function startUnifiedDaemon(
  options: UnifiedDaemonOptions,
): Promise<UnifiedDaemon> {
  const logger = options.logger ?? new Logger();
  const host = options.host ?? DEFAULT_HOST;
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  const lifecycle = new ServiceLifecycle();
  const registry = new WebhookRegistry(databasePath(options.dataDirectory));
  const runtime = makeRuntime(logger);
  let server: http.Server;
  try {
    server = await listen({
      host,
      port: options.port,
      registry,
      runtime,
      logger,
      lifecycle,
      ...(options.authenticator == null
        ? {}
        : { authenticator: options.authenticator }),
    });
  } catch (error) {
    await runtime.dispose();
    registry.close();
    throw error;
  }
  logger.info("server_listening", {
    host,
    port: options.port,
    database: registry.path,
    maxConnections: server.maxConnections,
  });

  let stopPromise: Promise<void> | null = null;
  const stop: UnifiedDaemon["stop"] = (reason = "requested") => {
    if (stopPromise != null) return stopPromise;
    stopPromise = (async () => {
      let httpDrained = false;
      let deliveryDrained = false;
      try {
        lifecycle.beginDrain();
        logger.info("server_draining", { reason, graceMs });
        const deadline = Date.now() + graceMs;
        httpDrained = await closeCodexhookServer(server, graceMs);
        await lifecycle.waitForIdle(Math.max(0, deadline - Date.now()));
        await runtime.runPromise(
          Effect.flatMap(Delivery, (service) => service.stopAccepting),
        );
        deliveryDrained = await runtime.runPromise(
          Effect.flatMap(Delivery, (service) =>
            service.drain(Math.max(0, deadline - Date.now())),
          ),
        );
      } finally {
        try {
          await runtime.dispose();
        } finally {
          registry.close();
          lifecycle.stopped();
          logger.info("server_stopped", {
            reason,
            httpDrained,
            deliveryDrained,
          });
        }
      }
    })();
    return stopPromise;
  };

  return { server, stop };
}
