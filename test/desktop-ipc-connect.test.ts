import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { connectDesktop } from "../src/transport/desktop.js";
import { isAbsentDesktopEndpointError } from "../src/transport/desktop-ipc/index.js";
import { TransportIncompatible } from "../src/transport/errors.js";
import type { TransportSpec } from "../src/transport/spec.js";
import {
  listen as listenRouter,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const output = Buffer.allocUnsafe(body.length + 4);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

test("only missing and refused endpoints prove Desktop is absent", () => {
  const error = (code: string) =>
    Object.assign(new Error(code), { code });
  assert.equal(isAbsentDesktopEndpointError(error("ENOENT")), true);
  assert.equal(isAbsentDesktopEndpointError(error("ECONNREFUSED")), true);
  assert.equal(isAbsentDesktopEndpointError(error("EACCES")), false);
  assert.equal(isAbsentDesktopEndpointError(error("EMFILE")), false);
  assert.equal(isAbsentDesktopEndpointError(error("ETIMEDOUT")), false);
});

test("a malformed Desktop initialize response is incompatible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-ipc-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\codexhook-test-${randomUUID()}`
      : path.join(directory, "ipc.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      const message = JSON.parse(
        buffered.subarray(4, length + 4).toString("utf8"),
      ) as { readonly requestId?: string };
      socket.write(frame({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "initialize",
        result: {},
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const spec = {
    _tag: "Desktop",
    id: "desktop",
    socketPath,
    approvals: "decline",
  } as const satisfies TransportSpec;
  try {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(connectDesktop(spec)),
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      assert.equal(
        Option.isSome(failure) &&
          failure.value instanceof TransportIncompatible &&
          failure.value.stage === "malformed",
        true,
      );
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupting a hanging Desktop initialize releases it promptly", async () => {
  const endpoint = await testEndpoint();
  let notifyConnected!: () => void;
  const connected = new Promise<void>((resolve) => {
    notifyConnected = resolve;
  });
  const router = await listenRouter(endpoint.socketPath, null, undefined, {
    onConnection: notifyConnected,
  });
  const spec = {
    _tag: "Desktop",
    id: "desktop",
    socketPath: endpoint.socketPath,
    approvals: "decline",
  } as const satisfies TransportSpec;
  try {
    const fiber = Effect.runFork(Effect.scoped(connectDesktop(spec)));
    await connected;
    const startedAt = Date.now();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Effect.runPromise(Fiber.interrupt(fiber)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Desktop interruption was not bounded")),
            500,
          );
        }),
      ]);
    } finally {
      if (timeout != null) clearTimeout(timeout);
    }
    assert.equal(Date.now() - startedAt < 500, true);
    const closeDeadline = Date.now() + 250;
    while (router.socketCount() !== 0 && Date.now() < closeDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(router.socketCount(), 0);
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});
