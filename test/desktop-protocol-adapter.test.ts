import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopIpcProtocol } from "../src/transport/desktop-protocol.js";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const output = Buffer.allocUnsafe(body.length + 4);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

test("Desktop steer preserves expected-turn and delivery identity fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-protocol-"));
  const socketPath = process.platform === "win32"
    ? `\\.\pipe\codexhook-protocol-${randomUUID()}`
    : path.join(directory, "ipc.sock");
  const sockets = new Set<net.Socket>();
  let observed: Record<string, unknown> | undefined;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const message = JSON.parse(
          buffered.subarray(4, length + 4).toString("utf8"),
        ) as {
          readonly method?: string;
          readonly params?: Record<string, unknown>;
          readonly requestId?: string;
        };
        buffered = buffered.subarray(length + 4);
        if (message.method === "initialize") {
          socket.write(frame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: { clientId: "test-client" },
          }));
        } else if (message.method === "thread-follower-steer-turn") {
          observed = message.params;
          socket.write(frame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: { result: {} },
          }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const protocol = await DesktopIpcProtocol.connect(socketPath);
    await protocol.inject({
      kind: "steer",
      threadId: "thread-1",
      expectedTurnId: "turn-active",
      clientUserMessageId: "delivery-1",
      input: [],
    });
    assert.equal(observed?.expectedTurnId, "turn-active");
    assert.equal(observed?.clientUserMessageId, "delivery-1");
    assert.equal("turnId" in (observed ?? {}), false);
    protocol.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
