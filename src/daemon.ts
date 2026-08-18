import type http from "node:http";
import { Effect, Layer, ManagedRuntime } from "effect";
import { LocalCodexLive } from "./app-server/local-codex.js";
import { LocalDeliveryCoordinator } from "./contracts/delivery.js";
import { Desktop } from "./contracts/desktop.js";
import {
  DEFAULT_HOST,
  SHUTDOWN_GRACE_MS,
  databasePath,
} from "./config.js";
import { Delivery, DeliveryLive } from "./delivery/delivery.js";
import { LocalCodex } from "./contracts/local-codex.js";
import { LocalDeliveryCoordinatorLive } from "./delivery/coordinator.js";
import { Logger } from "./logger.js";
import { WebhookRegistry } from "./registry.js";
import {
  closeCodexhookServer,
  listen,
} from "./server.js";
import type { RequestAuthenticator } from "./service/auth.js";
import { ServiceLifecycle } from "./service/lifecycle.js";
import { TransportProviderLive } from "./transport/provider.js";
import { DesktopProtocolLive } from "./transport/desktop-contract.js";

type DaemonRuntime = ManagedRuntime.ManagedRuntime<
  Delivery | LocalCodex | Desktop | LocalDeliveryCoordinator,
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
  const planes = Layer.merge(LocalCodexLive, DesktopProtocolLive).pipe(
    Layer.provide(TransportProviderLive(logger)),
  );
  const coordinator = LocalDeliveryCoordinatorLive.pipe(
    Layer.provide(planes),
  );
  const delivery = DeliveryLive(logger).pipe(
    Layer.provide(Layer.merge(planes, coordinator)),
  );
  const services = Layer.mergeAll(planes, coordinator, delivery);
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
    // Materialize every daemon-owned service before the listener advertises
    // readiness. ManagedRuntime memoizes these layers for later requests.
    await runtime.runPromise(Effect.all({
      delivery: Effect.flatMap(Delivery, (service) => service.snapshot),
      taskAccess: Effect.flatMap(
        LocalCodex,
        (service) => service.availability,
      ),
      desktopAccess: Effect.flatMap(
        Desktop,
        (service) => service.availability,
      ),
    }));
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
        const httpGraceMs = Math.floor(graceMs / 2);
        httpDrained = await closeCodexhookServer(server, httpGraceMs);
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
