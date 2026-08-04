import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { probeDaemon } from "../src/daemon-control.js";

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listener(body: unknown): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

test("recognizes an available codexhook listener", async () => {
  const origin = await listener({
    service: "codexhook",
    version: "1.2.3",
    status: "ok",
    capabilities: {
      desktopIpcAvailable: true,
    },
  });

  assert.deepEqual(await probeDaemon(origin), {
    state: "running",
    health: {
      state: "available",
      version: "1.2.3",
      desktopIpcAvailable: true,
    },
  });
});

test("accepts a degraded codexhook listener as running", async () => {
  const origin = await listener({
    service: "codexhook",
    version: "1.2.3",
    status: "degraded",
    capabilities: {
      desktopIpcAvailable: false,
    },
  });

  assert.equal((await probeDaemon(origin)).state, "running");
  const result = await probeDaemon(origin);
  assert.equal(
    result.state === "running" ? result.health.state : null,
    "degraded",
  );
});

test("distinguishes another service from a refused connection", async () => {
  const origin = await listener({ status: "ok" });
  assert.deepEqual(await probeDaemon(origin), { state: "occupied" });
  assert.deepEqual(
    await probeDaemon("http://127.0.0.1:1", 100),
    { state: "down" },
  );
});
