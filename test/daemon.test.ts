import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { startUnifiedDaemon } from "../src/daemon.js";
import { probeDaemon } from "../src/daemon-control.js";
import { Logger } from "../src/logger.js";
import { diagnosticJournalPath } from "../src/config.js";

function memoryLogger(): {
  readonly entries: Array<Record<string, unknown>>;
  readonly logger: Logger;
} {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    logger: new Logger(
      new Writable({
        write(chunk, _encoding, callback) {
          entries.push(JSON.parse(String(chunk)));
          callback();
        },
      }),
    ),
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("the unified daemon starts healthy and stops idempotently", async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "codexhook-daemon-"));
  const { entries, logger } = memoryLogger();
  const daemon = await startUnifiedDaemon({
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    shutdownGraceMs: 1_000,
    logger,
  });
  try {
    const address = daemon.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${origin}/healthz`);
    const body = await health.json() as {
      status: string;
      lifecycle: { phase: string };
      taskAccess: { status: string };
    };
    assert.equal(health.status, body.status === "ok" ? 200 : 503);
    assert.equal(body.lifecycle.phase, "ready");
    const probe = await probeDaemon(origin);
    assert.equal(probe.state, "running");
    if (probe.state === "running") {
      assert.equal(probe.health.phase, "ready");
      assert.equal(
        probe.health.taskAccessStatus,
        body.taskAccess.status,
      );
    }

    await Promise.all([daemon.stop("test"), daemon.stop("duplicate")]);
    assert.equal(
      entries.some((entry) => entry.event === "server_stopped"),
      true,
    );
    assert.equal(
      existsSync(diagnosticJournalPath(dataDirectory)),
      false,
      "an idle daemon does not create an empty journal",
    );
    await assert.rejects(fetch(`${origin}/healthz`));
  } finally {
    await daemon.stop("cleanup");
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test(
  "the bundled serve process exits cleanly after SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    const dataDirectory = mkdtempSync(
      path.join(tmpdir(), "codexhook-process-"),
    );
    const port = await unusedPort();
    const child = spawn(
      process.execPath,
      [
        path.resolve("dist/codexhook.mjs"),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-directory",
        dataDirectory,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    let signaled = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (!signaled && stderr.includes('"event":"server_listening"')) {
        signaled = true;
        child.kill("SIGTERM");
      }
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("serve did not exit after SIGTERM"));
      }, 5_000);
      timeoutHandle.unref();
    });
    try {
      const result = await Promise.race([exited, timeout]);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.match(stderr, /"event":"server_stopped"/);
    } finally {
      clearTimeout(timeoutHandle);
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  },
);
