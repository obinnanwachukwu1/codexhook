import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DesktopFrameDecoder,
  encodeDesktopFrame,
} from "../../src/transport/desktop-ipc/framing.js";
import type { DesktopWireEnvelope } from "../../src/transport/desktop-ipc/index.js";

export type MessageHandler = (
  message: DesktopWireEnvelope,
  send: (message: unknown) => void,
  sendRaw: (frame: Buffer) => void,
  closeConnection: () => void,
) => void;

export interface RouterOptions {
  readonly afterInitialize?: (send: (message: unknown) => void) => void;
  readonly initializeDelayMs?: number;
  readonly initializeResultType?: string;
  readonly onConnection?: () => void;
  readonly onInitialize?: (message: DesktopWireEnvelope) => void;
}

export interface Router {
  readonly close: () => Promise<void>;
  readonly socketCount: () => number;
}

export function sendOwnerSnapshot(
  message: DesktopWireEnvelope,
  send: (message: unknown) => void,
  threadId = "thread-1",
  owner = "desktop-owner",
): boolean {
  if (message.method !== "thread-stream-following-changed") return false;
  send({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: owner,
    params: {
      conversationId: threadId,
      change: { type: "snapshot", revision: 1 },
    },
  });
  return true;
}

const fixtures = fileURLToPath(new URL(
  "../../../test/fixtures/desktop-ipc/",
  import.meta.url,
));

export async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
}

export async function listen(
  socketPath: string,
  initialize: unknown,
  handler: MessageHandler = () => undefined,
  options: RouterOptions = {},
): Promise<Router> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    options.onConnection?.();
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const decoder = new DesktopFrameDecoder();
    const send = (message: unknown) => socket.write(encodeDesktopFrame(message));
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.method === "initialize") {
          options.onInitialize?.(message);
          if (initialize != null) {
            const respond = () => {
              send({
                type: "response",
                requestId: message.requestId,
                resultType: options.initializeResultType ?? "success",
                result: initialize,
              });
              options.afterInitialize?.(send);
            };
            if (options.initializeDelayMs == null) respond();
            else setTimeout(respond, options.initializeDelayMs);
          }
          continue;
        }
        handler(
          message,
          send,
          (frame) => socket.write(frame),
          () => socket.destroy(),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketCount: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function testEndpoint(): Promise<{
  readonly cleanup: () => Promise<void>;
  readonly socketPath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-protocol-"));
  return {
    socketPath: process.platform === "win32"
      ? `\\\\.\\pipe\\codexhook-protocol-${randomUUID()}`
      : path.join(directory, "ipc.sock"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
