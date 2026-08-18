import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { startUnifiedDaemon } from "../src/daemon.js";
import { probeDaemon } from "../src/daemon-control.js";

test("the unified daemon starts healthy and stops idempotently", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "codexhook-daemon-"));
  const daemon = await startUnifiedDaemon({
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    shutdownGraceMs: 1_000,
  });
  try {
    const address = daemon.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${origin}/healthz`);
    const body = await health.json() as {
      status: string;
      delivery: string;
      lifecycle: { phase: string };
      taskAccess: { source: string; candidatesFound: boolean };
    };
    assert.equal(health.status, body.status === "ok" ? 200 : 503);
    assert.equal(body.lifecycle.phase, "ready");
    assert.equal(body.taskAccess.source, "app-server");
    const probe = await probeDaemon(origin);
    assert.equal(probe.state, "running");
    if (probe.state === "running") {
      assert.equal(probe.health.phase, "ready");
      assert.equal(probe.health.delivery, body.delivery);
      assert.equal(
        probe.health.taskAccessCandidatesFound,
        body.taskAccess.candidatesFound,
      );
    }

    await Promise.all([daemon.stop("test"), daemon.stop("duplicate")]);
    assert.equal(daemon.lifecycle.snapshot().phase, "stopped");
    await assert.rejects(fetch(`${origin}/healthz`));
  } finally {
    await daemon.stop("cleanup");
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
