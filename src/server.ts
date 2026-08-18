import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  Effect,
  ManagedRuntime,
  Option,
} from "effect";
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_HTTP_CONNECTIONS,
} from "./config.js";
import { Delivery } from "./delivery/delivery.js";
import { Logger } from "./logger.js";
import { ThreadRateLimiter } from "./rate-limit.js";
import { WebhookRegistry } from "./registry.js";
import { CodexTransport } from "./transport/transport.js";
import { VERSION } from "./version.js";
import {
  noAdditionalAuthentication,
  type RequestAuthenticator,
} from "./service/auth.js";
import {
  ServiceLifecycle,
} from "./service/lifecycle.js";
import { appServerTaskStatus } from "./service/local-tasks.js";

export interface CodexhookServerOptions {
  host: string;
  port: number;
  registry: WebhookRegistry;
  runtime: ManagedRuntime.ManagedRuntime<Delivery | CodexTransport, never>;
  logger?: Logger;
  rateLimiter?: ThreadRateLimiter;
  lifecycle?: ServiceLifecycle;
  authenticator?: RequestAuthenticator;
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume();
    throw new RangeError("request body is too large");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      request.destroy();
      throw new RangeError("request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createCodexhookServer(
  options: CodexhookServerOptions,
): http.Server {
  const logger = options.logger ?? new Logger();
  const rateLimiter = options.rateLimiter ?? new ThreadRateLimiter();
  const lifecycle = options.lifecycle ?? new ServiceLifecycle();
  const authenticator =
    options.authenticator ?? noAdditionalAuthentication;

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );

      const healthRoute =
        request.method === "GET" &&
        requestUrl.pathname.endsWith("/healthz");
      if (healthRoute) {
        if (!(await authenticator.authorize(request, { kind: "health" }))) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        const state = await options.runtime.runPromise(
          Effect.all({
            transport: Effect.flatMap(
              CodexTransport,
              (service) => service.status,
            ),
            delivery: Effect.flatMap(
              Delivery,
              (service) => service.snapshot,
            ),
          }),
        );
        const lifecycleState = lifecycle.snapshot();
        const available =
          lifecycleState.accepting && state.transport.candidates.length > 0;
        json(response, available ? 200 : 503, {
          service: "codexhook",
          version: VERSION,
          status: available ? "ok" : "degraded",
          delivery: available ? "available" : "unavailable",
          capabilities: {
            desktopIpcAvailable:
              state.transport.desktopIpcAvailable,
          },
          candidates: state.transport.candidates,
          queuedThreads: state.delivery.lanes,
          lifecycle: lifecycleState,
          taskAccess: appServerTaskStatus(state.transport.candidates),
        });
        return;
      }

      const release = lifecycle.enter();
      if (release == null) {
        response.setHeader("connection", "close");
        json(response, 503, {
          error: `service is ${lifecycle.snapshot().phase}`,
        });
        return;
      }
      response.once("close", release);
      response.once("finish", release);

      const match = /\/w\/([A-Za-z0-9_-]+)$/.exec(requestUrl.pathname);
      if (request.method !== "POST" || match == null) {
        json(response, 404, { error: "not found" });
        return;
      }
      const token = match[1];
      if (token == null) {
        json(response, 404, { error: "not found" });
        return;
      }

      const inspected = options.registry.inspectToken(token);
      if (inspected == null) {
        json(response, 404, { error: "not found" });
        return;
      }
      if (
        !(await authenticator.authorize(request, {
          kind: "webhook",
          hook: inspected,
        }))
      ) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (!rateLimiter.allow(inspected.threadId)) {
        response.setHeader("retry-after", "60");
        json(response, 429, { error: "thread delivery rate exceeded" });
        return;
      }

      let body: string;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof RangeError && !response.headersSent) {
          json(response, 413, { error: "request body is too large" });
        }
        return;
      }

      const hook = options.registry.claimToken(token);
      if (hook == null) {
        json(response, 404, { error: "not found" });
        return;
      }
      const accepted = await options.runtime.runPromise(
        Effect.flatMap(Delivery, (service) => service.submit(hook, body)),
      );
      if (Option.isNone(accepted)) {
        logger.warn("delivery_dropped", {
          hookId: hook.id,
          threadId: hook.threadId,
          reason: "thread delivery queue is full",
        });
        // The hook was atomically claimed already. A 5xx would invite a
        // provider retry even though a one-shot URL is intentionally gone.
        json(response, 202, {
          accepted: true,
          deliveryId: null,
          hookId: hook.id,
          dropped: true,
          reason: "thread delivery queue is full",
        });
        return;
      }
      const deliveryId = accepted.value;
      logger.info("delivery_accepted", {
        deliveryId,
        hookId: hook.id,
        threadId: hook.threadId,
        mode: hook.mode,
        bytes: Buffer.byteLength(body),
      });
      json(response, 202, {
        accepted: true,
        deliveryId,
        hookId: hook.id,
      });
    } catch (error) {
      logger.error("http_request_failed", {
        method: request.method,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        json(response, 500, { error: "internal server error" });
      } else {
        response.end();
      }
    }
  });
  server.maxConnections = MAX_HTTP_CONNECTIONS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.once("listening", () => {
    if (lifecycle.snapshot().phase === "starting") lifecycle.ready();
  });
  return server;
}

export async function listen(
  options: CodexhookServerOptions,
): Promise<http.Server> {
  const server = createCodexhookServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function closeCodexhookServer(
  server: http.Server,
  timeoutMs: number,
): Promise<boolean> {
  let timedOut = false;
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  const idleCloser = setInterval(() => {
    server.closeIdleConnections();
  }, 10);
  idleCloser.unref();
  void closed.finally(() => clearInterval(idleCloser));
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
    timer.unref();
    void closed.finally(() => clearTimeout(timer));
  });
  await Promise.race([closed, timeout]);
  if (timedOut) await closed;
  return !timedOut;
}
