import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { DEFAULT_PORT } from "../src/config.js";
import {
  chooseInstallationPort,
  parsePort,
  portIsAvailable,
} from "../src/port.js";

test("availability probing detects a bound loopback port", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address != null && typeof address !== "string");
  assert.equal(await portIsAvailable(address.port), false);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error == null ? resolve() : reject(error));
  });
  assert.equal(await portIsAvailable(address.port), true);
});

test("a fresh install prefers the default port", async () => {
  assert.equal(
    await chooseInstallationPort({
      isAvailable: async (port) => port === DEFAULT_PORT,
    }),
    DEFAULT_PORT,
  );
});

test("a fresh install falls back to an available random high port", async () => {
  const candidates = [50_001, 50_002];
  assert.equal(
    await chooseInstallationPort({
      isAvailable: async (port) => port === 50_002,
      randomPort: () => candidates.shift() ?? 50_002,
    }),
    50_002,
  );
});

test("an existing install preserves its port without probing", async () => {
  let probes = 0;
  assert.equal(
    await chooseInstallationPort({
      previous: 51_234,
      isAvailable: async () => {
        probes += 1;
        return false;
      },
    }),
    51_234,
  );
  assert.equal(probes, 0);
});

test("an explicit available port is selected", async () => {
  assert.equal(
    await chooseInstallationPort({
      requested: 12_345,
      isAvailable: async (port) => port === 12_345,
    }),
    12_345,
  );
});

test("an explicit occupied port is rejected before installation", async () => {
  await assert.rejects(
    chooseInstallationPort({
      requested: 12_345,
      isAvailable: async () => false,
    }),
    /port 12345 is already in use/,
  );
});

test("requesting the existing port preserves it even during a collision", async () => {
  let probes = 0;
  assert.equal(
    await chooseInstallationPort({
      requested: 12_345,
      previous: 12_345,
      isAvailable: async () => {
        probes += 1;
        return false;
      },
    }),
    12_345,
  );
  assert.equal(probes, 0);
});

test("ports are parsed strictly", () => {
  assert.equal(parsePort("9465"), 9465);
  assert.throws(() => parsePort("0"), /between 1 and 65535/);
  assert.throws(() => parsePort("1.5"), /between 1 and 65535/);
  assert.throws(() => parsePort("65536"), /between 1 and 65535/);
});
