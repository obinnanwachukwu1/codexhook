import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { IpcEnvelope } from "../../src/transport/desktop-ipc-client.js";

export type FakeDesktopBehavior =
  | "normal"
  | "disconnect-on-connect"
  | "disconnect-after-write"
  | "lost-acknowledgement"
  | "incompatible-response";

export interface FakeDesktopIpcHarness {
  readonly socketPath: string;
  readonly received: ReadonlyArray<IpcEnvelope>;
  readonly generation: number;
  emit: (message: IpcEnvelope) => void;
  disconnectClients: () => void;
  replace: (behavior?: FakeDesktopBehavior) => Promise<FakeDesktopIpcHarness>;
  close: () => Promise<void>;
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const framed = Buffer.allocUnsafe(body.length + 4);
  framed.writeUInt32LE(body.length, 0);
  body.copy(framed, 4);
  return framed;
}

async function listen(
  socketPath: string,
  directory: string,
  behavior: FakeDesktopBehavior,
  generation: number,
): Promise<FakeDesktopIpcHarness> {
  const received: IpcEnvelope[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (behavior === "disconnect-on-connect") {
      socket.destroy();
      return;
    }
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const message = JSON.parse(
          buffered.subarray(4, length + 4).toString("utf8"),
        ) as IpcEnvelope;
        buffered = buffered.subarray(length + 4);
        received.push(message);
        if (behavior === "disconnect-after-write") {
          socket.destroy();
          continue;
        }
        if (behavior === "lost-acknowledgement") continue;
        if (message.method === "initialize") {
          socket.write(frame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: behavior === "incompatible-response"
              ? { unexpected: true }
              : { clientId: `fake-desktop-${generation}` },
          }));
        } else if (message.type === "request") {
          socket.write(frame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: { result: { turn: {
              id: `turn-${generation}`,
              status: "inProgress",
              error: null,
            } } },
          }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  let closed = false;
  const disconnectClients = () => {
    for (const socket of sockets) socket.destroy();
  };
  const closeServer = async (removeDirectory: boolean) => {
    if (closed) return;
    closed = true;
    disconnectClients();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (removeDirectory) await rm(directory, { recursive: true, force: true });
  };
  return {
    socketPath,
    received,
    generation,
    emit(message) {
      for (const socket of sockets) socket.write(frame(message));
    },
    disconnectClients,
    async replace(nextBehavior = "normal") {
      await closeServer(false);
      if (process.platform !== "win32") {
        await unlink(socketPath).catch(() => undefined);
      }
      return listen(socketPath, directory, nextBehavior, generation + 1);
    },
    close: () => closeServer(true),
  };
}

export async function fakeDesktopIpc(
  behavior: FakeDesktopBehavior = "normal",
): Promise<FakeDesktopIpcHarness> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-fake-ipc-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\codexhook-fake-${randomUUID()}`
    : path.join(directory, "ipc.sock");
  return listen(socketPath, directory, behavior, 1);
}
