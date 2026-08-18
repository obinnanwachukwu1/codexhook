import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Cause, Duration, Effect, Exit, Fiber, Option } from "effect";
import { TransportUnavailable } from "../src/transport/errors.js";
import { connectUnixPeer } from "../src/transport/unix-peer.js";
import type { TransportSpec } from "../src/transport/spec.js";

async function hangingSocketFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-ws-"));
  const socketPath = path.join(directory, "app-server.sock");
  const sockets = new Set<net.Socket>();
  let notifyConnected!: () => void;
  const connected = new Promise<void>((resolve) => {
    notifyConnected = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    notifyConnected();
    // Accept TCP but never complete the WebSocket upgrade.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const spec = {
    _tag: "UnixSocket",
    id: "daemon",
    socketPath,
    approvals: "decline",
  } as const satisfies TransportSpec;
  return {
    connected,
    spec,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  "interrupting a hanging Unix WebSocket acquire releases it promptly",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await hangingSocketFixture();
    try {
      const fiber = Effect.runFork(
        Effect.scoped(connectUnixPeer(fixture.spec)),
      );
      await fixture.connected;
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
      await Promise.race([
        interrupted,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Unix peer interruption was not bounded")),
            500,
          );
          timer.unref();
        }),
      ]);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "a hanging Unix WebSocket acquire fails within its open budget",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await hangingSocketFixture();
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          connectUnixPeer(fixture.spec, undefined, Duration.millis(10)),
        ),
      );
      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        assert.equal(
          Option.isSome(failure) &&
            failure.value instanceof TransportUnavailable &&
            failure.value.reason === "connect-failed",
          true,
        );
      }
    } finally {
      await fixture.close();
    }
  },
);
