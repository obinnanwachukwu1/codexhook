import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { startUnifiedDaemon } from "../src/daemon.js";

test("the unified daemon starts healthy and stops idempotently", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "codexhook-daemon-"));
  const daemon = await startUnifiedDaemon({
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    shutdownGraceMs: 1_000,
  });
  const address = daemon.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${origin}/healthz`);
  const body = await health.json() as {
    status: string;
    lifecycle: { phase: string };
    taskAccess: { source: string };
  };
  assert.equal(health.status, 200);
  assert.equal(body.lifecycle.phase, "ready");
  assert.equal(body.taskAccess.source, "app-server");

  await Promise.all([daemon.stop("test"), daemon.stop("duplicate")]);
  assert.equal(daemon.lifecycle.snapshot().phase, "stopped");
  await assert.rejects(fetch(`${origin}/healthz`));
});
