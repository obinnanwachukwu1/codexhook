import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import { connectDesktop } from "../src/transport/desktop.js";
import { TransportIncompatible } from "../src/transport/errors.js";
import type { TransportSpec } from "../src/transport/spec.js";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const output = Buffer.allocUnsafe(body.length + 4);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

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
