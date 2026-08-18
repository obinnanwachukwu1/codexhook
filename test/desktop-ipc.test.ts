import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect, Exit, Schema } from "effect";
import {
  connectDesktop,
} from "../src/transport/desktop.js";
import { desktopSocketIsPrivate } from "../src/transport/desktop-endpoint.js";
import {
  RpcNotWritten,
  RpcWriteAmbiguous,
} from "../src/transport/rpc.js";
import type { TransportSpec } from "../src/transport/spec.js";
import { TurnStartResult } from "../src/transport/protocol.js";
import { ThreadId, TurnId } from "../src/types.js";

type StartBehavior =
  | "success"
  | "delayed-visibility"
  | "safe-reject"
  | "unknown-reject"
  | "disconnect";

interface Router {
  readonly close: () => Promise<void>;
  readonly socketPath: string;
}
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const output = Buffer.allocUnsafe(body.length + 4);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

async function mockRouter(behavior: StartBehavior): Promise<Router> {
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
    const send = (value: unknown) => socket.write(frame(value));
    const sendSplit = (value: unknown) => {
      const output = frame(value);
      socket.write(output.subarray(0, 2));
      socket.write(output.subarray(2, 7));
      socket.write(output.subarray(7));
    };
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const message = JSON.parse(
          buffered.subarray(4, length + 4).toString("utf8"),
        ) as {
          type: string;
          method?: string;
          requestId?: string;
          params?: { conversationId?: string };
        };
        buffered = buffered.subarray(length + 4);
        if (message.method === "initialize") {
          sendSplit({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            result: { clientId: "desktop-test-client" },
          });
        } else if (
          message.type === "broadcast" &&
          message.method === "thread-stream-following-changed"
        ) {
          const ignored = frame({
            type: "broadcast",
            method: "unknown-future-event",
            version: 999,
            params: {},
          });
          const snapshot = frame({
            type: "broadcast",
            method: "thread-stream-state-changed",
            version: 11,
            params: {
              conversationId: message.params?.conversationId,
              hostId: "local",
              change: {
                type: "snapshot",
                revision: 1,
                conversationState: {
                  turnHistory: {
                    history: { entitiesByKey: {} },
                  },
                },
              },
            },
          });
          socket.write(Buffer.concat([ignored, snapshot]));
          if (behavior === "delayed-visibility") {
            setTimeout(() => {
              send({
                type: "broadcast",
                method: "thread-stream-state-changed",
                version: 11,
                params: {
                  conversationId: "thread-1",
                  hostId: "local",
                  change: {
                    type: "patches",
                    baseRevision: 1,
                    revision: 2,
                    patches: [{
                      op: "add",
                      path: [
                        "turnHistory",
                        "history",
                        "entitiesByKey",
                        "delayed",
                      ],
                      value: {
                        turnId: "turn-delayed",
                        status: "completed",
                        error: null,
                      },
                    }],
                  },
                },
              });
            }, 20);
          }
        } else if (message.method === "thread-follower-start-turn") {
          if (behavior === "disconnect") {
            socket.destroy();
          } else if (behavior === "safe-reject") {
            send({
              type: "response",
              requestId: message.requestId,
              resultType: "error",
              error: "request-version-mismatch",
            });
          } else if (behavior === "unknown-reject") {
            send({
              type: "response",
              requestId: message.requestId,
              resultType: "error",
              error: "unexpected-owner-handler-failure",
            });
          } else {
            send({
              type: "response",
              requestId: message.requestId,
              resultType: "success",
              result: {
                result: {
                  turn: {
                    id: "turn-ipc",
                    status: "inProgress",
                    error: null,
                  },
                },
              },
            });
            setTimeout(() => {
              send({
                type: "broadcast",
                method: "thread-stream-state-changed",
                version: 11,
                params: {
                  conversationId: "thread-1",
                  hostId: "local",
                  change: {
                    type: "patches",
                    baseRevision: 1,
                    revision: 2,
                    patches: [
                      {
                        op: "replace",
                        path: [
                          "turnHistory",
                          "history",
                          "entitiesByKey",
                          "new",
                          "turnId",
                        ],
                        value: "turn-ipc",
                      },
                      {
                        op: "replace",
                        path: [
                          "turnHistory",
                          "history",
                          "entitiesByKey",
                          "new",
                          "status",
                        ],
                        value: "completed",
                      },
                    ],
                  },
                },
              });
            }, 5);
          }
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function spec(socketPath: string): Extract<
  TransportSpec,
  { readonly _tag: "Desktop" }
> {
  return {
    _tag: "Desktop",
    id: "desktop",
    socketPath,
    approvals: "decline",
  };
}

function submitStart(socketPath: string) {
  return Effect.scoped(
    connectDesktop(spec(socketPath)).pipe(
      Effect.flatMap((peer) =>
        peer.request(
          "thread/resume",
          { threadId: "thread-1" },
          Schema.Unknown,
          "1 second",
        ).pipe(
          Effect.zipRight(
            peer.prepare("turn/start", {
              threadId: "thread-1",
              clientUserMessageId: "delivery-1",
              input: [{ type: "text", text: "hello" }],
            }),
          ),
          Effect.flatMap((ticket) =>
            peer.submit(ticket).pipe(
              Effect.zipRight(
                peer.reply(ticket, TurnStartResult, "1 second"),
              ),
              Effect.flatMap((result) =>
                peer.awaitTurn(
                  ThreadId("thread-1"), TurnId(result.turn.id), "1 second",
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function awaitExistingTurn(socketPath: string) {
  return Effect.scoped(
    connectDesktop(spec(socketPath)).pipe(
      Effect.flatMap((peer) =>
        peer.request(
          "thread/resume",
          { threadId: "thread-1" },
          Schema.Unknown,
          "1 second",
        ).pipe(
          Effect.zipRight(
            peer.awaitTurn(
              ThreadId("thread-1"), TurnId("turn-delayed"), "1 second",
            ),
          ),
        ),
      ),
    ),
  );
}

test("Desktop IPC follows a task and observes turn completion", async () => {
  const router = await mockRouter("success");
  try {
    const turn = await Effect.runPromise(submitStart(router.socketPath));
    assert.equal(turn.id, "turn-ipc");
    assert.equal(turn.status, "completed");
  } finally {
    await router.close();
  }
});

test("Desktop IPC waits for a followed turn to arrive in a later patch", async () => {
  const router = await mockRouter("delayed-visibility");
  try {
    const turn = await Effect.runPromise(
      awaitExistingTurn(router.socketPath),
    );
    assert.equal(turn.id, "turn-delayed");
    assert.equal(turn.status, "completed");
  } finally {
    await router.close();
  }
});

test("confirmed IPC incompatibility is safe for app-server fallback", async () => {
  const router = await mockRouter("safe-reject");
  try {
    const exit = await Effect.runPromiseExit(submitStart(router.socketPath));
    assert.equal(
      Exit.isFailure(exit) &&
        String(exit.cause).includes(RpcNotWritten.name),
      true,
    );
  } finally {
    await router.close();
  }
});

test("IPC disconnect after submission remains ambiguous", async () => {
  const router = await mockRouter("disconnect");
  try {
    const exit = await Effect.runPromiseExit(submitStart(router.socketPath));
    assert.equal(
      Exit.isFailure(exit) &&
        String(exit.cause).includes(RpcWriteAmbiguous.name),
      true,
    );
  } finally {
    await router.close();
  }
});

test("unknown IPC handler errors are not declared safe to retry", async () => {
  const router = await mockRouter("unknown-reject");
  try {
    const exit = await Effect.runPromiseExit(submitStart(router.socketPath));
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(String(exit.cause).includes("RpcErrorReply"), true);
      assert.equal(String(exit.cause).includes(RpcNotWritten.name), false);
    }
  } finally {
    await router.close();
  }
});

test("Desktop IPC rejects exposed and symlinked socket paths", async () => {
  if (process.platform === "win32") return;
  const router = await mockRouter("success");
  const linkPath = `${router.socketPath}.link`;
  try {
    await chmod(router.socketPath, 0o600);
    assert.equal(await desktopSocketIsPrivate(router.socketPath), true);
    await chmod(router.socketPath, 0o666);
    assert.equal(await desktopSocketIsPrivate(router.socketPath), false);
    await chmod(router.socketPath, 0o600);
    await symlink(router.socketPath, linkPath);
    assert.equal(await desktopSocketIsPrivate(linkPath), false);
  } finally {
    await router.close();
  }
});

test("a missing Desktop IPC endpoint is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-ipc-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\codexhook-missing-${randomUUID()}`
      : path.join(directory, "missing.sock");
  try {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(connectDesktop(spec(socketPath))),
    );
    assert.equal(Exit.isFailure(exit), true);
    if (process.platform !== "win32") {
      assert.equal(await desktopSocketIsPrivate(socketPath), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
