import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Option,
} from "effect";
import {
  Delivery,
  type DeliveryService,
} from "../src/delivery/delivery.js";
import { WebhookRegistry } from "../src/registry.js";
import {
  closeCodexhookServer,
  createCodexhookServer,
} from "../src/server.js";
import {
  CodexTransport,
  type CodexTransportService,
} from "../src/transport/transport.js";
import { DeliveryId } from "../src/types.js";
import type { TransportId } from "../src/types.js";
import type { RequestAuthenticator } from "../src/service/auth.js";
import { ServiceLifecycle } from "../src/service/lifecycle.js";

const closeables: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) await close();
});

async function fixture(
  submit: DeliveryService["submit"],
  options: {
    authenticator?: RequestAuthenticator;
    lifecycle?: ServiceLifecycle;
    transportCandidates?: ReadonlyArray<TransportId>;
  } = {},
): Promise<{
  registry: WebhookRegistry;
  origin: string;
  server: http.Server;
}> {
  const directory = mkdtempSync(path.join(tmpdir(), "codexhook-server-"));
  const registry = new WebhookRegistry(path.join(directory, "hooks.sqlite"));
  const { transportCandidates = ["cli"], ...serverOptions } = options;
  const delivery = Delivery.of({
    submit,
    snapshot: Effect.succeed({
      lanes: 0,
      depths: {},
      steerDepth: 0,
    }),
    stopAccepting: Effect.void,
    drain: () => Effect.succeed(true),
  });
  const transport = CodexTransport.of({
    deliver: () => Effect.die("not used by the HTTP test"),
    status: Effect.succeed({
      candidates: transportCandidates,
      desktopIpcAvailable: false,
    }),
  } satisfies CodexTransportService);
  const runtime = ManagedRuntime.make(
    Layer.merge(
      Layer.succeed(Delivery, delivery),
      Layer.succeed(CodexTransport, transport),
    ),
  );
  const server = createCodexhookServer({
    host: "127.0.0.1",
    port: 0,
    registry,
    runtime,
    ...serverOptions,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  closeables.push(
    async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.dispose();
      registry.close();
    },
  );
  return {
    registry,
    origin: `http://127.0.0.1:${address.port}`,
    server,
  };
}

test("accepts a prefixed one-shot URL and forwards the exact body", async () => {
  const deliveries: string[] = [];
  const { registry, origin } = await fixture((_hook, body) =>
    Effect.sync(() => {
      deliveries.push(body);
      return Option.some(DeliveryId("delivery-1"));
    }),
  );
  const hook = registry.create({
    id: "build-result",
    threadId: "thread-1",
    mode: "queue",
    prependBody: "",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    maxDeliveries: 1,
  });
  const url = `${origin}/custom/prefix/w/${hook.token}`;

  const first = await fetch(url, { method: "POST", body: "payload\n" });
  assert.equal(first.status, 202);
  assert.equal((await first.json() as { accepted: boolean }).accepted, true);
  assert.deepEqual(deliveries, ["payload\n"]);

  const second = await fetch(url, { method: "POST", body: "again" });
  assert.equal(second.status, 404);
});

test("reports a claimed queue overflow as terminal, not retryable", async () => {
  const { registry, origin } = await fixture(() =>
    Effect.succeed(Option.none()),
  );
  const hook = registry.create({
    id: "full",
    threadId: "thread-1",
    mode: "queue",
    prependBody: "",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    maxDeliveries: 1,
  });
  const url = `${origin}/w/${hook.token}`;

  const response = await fetch(url, { method: "POST", body: "payload" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    deliveryId: null,
    hookId: "full",
    dropped: true,
    reason: "thread delivery queue is full",
  });
  assert.equal((await fetch(url, { method: "POST" })).status, 404);
});

test("health responses identify the codexhook listener", async () => {
  const { origin } = await fixture(() => Effect.succeed(Option.none()));
  const response = await fetch(`${origin}/healthz`);
  const health = await response.json() as {
    service: string;
    version: string;
    status: string;
    capabilities: {
      desktopIpcAvailable: boolean;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(health.service, "codexhook");
  assert.match(health.version, /^\d+\.\d+\.\d+$/);
  assert.equal(health.status, "ok");
  assert.deepEqual(health.capabilities, {
    desktopIpcAvailable: false,
  });
});

test("the HTTP server owns the ready transition", async () => {
  const lifecycle = new ServiceLifecycle();
  await fixture(
    () => Effect.succeed(Option.none()),
    { lifecycle },
  );
  assert.equal(lifecycle.snapshot().phase, "ready");
});

test("health preserves the degraded status code", async () => {
  const { origin } = await fixture(
    () => Effect.succeed(Option.none()),
    { transportCandidates: [] },
  );
  const health = await fetch(`${origin}/healthz`);
  const body = await health.json() as {
    status: string;
    delivery: string;
  };
  assert.equal(health.status, 503);
  assert.equal(body.status, "degraded");
  assert.equal(body.delivery, "unavailable");
});

test("authorization runs before a webhook capability is claimed", async () => {
  let allowed = false;
  const { registry, origin } = await fixture(
    () => Effect.succeed(Option.some(DeliveryId("delivery-1"))),
    {
      authenticator: {
        authorize: (_request, target) =>
          target.kind === "health" || allowed,
      },
    },
  );
  const hook = registry.create({
    id: "protected",
    threadId: "thread-1",
    mode: "queue",
    prependBody: "",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    maxDeliveries: 1,
  });
  const url = `${origin}/w/${hook.token}`;

  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  allowed = true;
  assert.equal((await fetch(url, { method: "POST" })).status, 202);
});

test("health fails during drain without spending webhook tokens", async () => {
  const lifecycle = new ServiceLifecycle();
  lifecycle.ready();
  const { registry, origin } = await fixture(
    () => Effect.succeed(Option.some(DeliveryId("delivery-1"))),
    { lifecycle },
  );
  const hook = registry.create({
    id: "draining",
    threadId: "thread-1",
    mode: "queue",
    prependBody: "",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    maxDeliveries: 1,
  });
  lifecycle.beginDrain();

  assert.equal((await fetch(`${origin}/healthz`)).status, 503);
  assert.equal(
    (await fetch(`${origin}/w/${hook.token}`, { method: "POST" })).status,
    503,
  );
  assert.notEqual(registry.inspectToken(hook.token), null);
});

test("forced HTTP shutdown is bounded", async () => {
  const server = http.createServer(() => {
    // Intentionally hold the response open until shutdown destroys the socket.
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address() as AddressInfo;
  const connected = new Promise<void>((resolve) =>
    server.once("connection", () => resolve()),
  );
  const request = http.get(`http://127.0.0.1:${address.port}`);
  request.on("error", () => undefined);
  await connected;

  assert.equal(await closeCodexhookServer(server, 5), false);
  request.destroy();
});

test("an admitted webhook finishes during graceful drain", async () => {
  const lifecycle = new ServiceLifecycle();
  const bodies: string[] = [];
  const { registry, origin, server } = await fixture(
    (_hook, body) => Effect.sync(() => {
      bodies.push(body);
      return Option.some(DeliveryId("delivery-1"));
    }),
    { lifecycle },
  );
  const hook = registry.create({
    id: "in-flight",
    threadId: "thread-1",
    mode: "queue",
    prependBody: "",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    maxDeliveries: 1,
  });
  let request: http.ClientRequest;
  const response = new Promise<number | undefined>((resolve, reject) => {
    request = http.request(
      `${origin}/w/${hook.token}`,
      { method: "POST" },
      (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolve(incoming.statusCode));
      },
    );
    request.once("error", reject);
  });
  request!.write("partial");
  while (lifecycle.snapshot().activeRequests === 0) {
    await new Promise((next) => setTimeout(next, 1));
  }
  lifecycle.beginDrain();
  const closing = closeCodexhookServer(server, 1_000);
  request!.end(" body");

  assert.equal(await response, 202);
  assert.equal(await closing, true);
  assert.deepEqual(bodies, ["partial body"]);
});
