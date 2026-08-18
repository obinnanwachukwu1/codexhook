import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type DesktopTaskChange,
  DesktopIpcProtocol,
} from "../src/transport/desktop-task-protocol.js";
import {
  fixture,
  listen,
  sendOwnerSnapshot,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

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
    ? `\\\\.\\pipe\\codexhook-protocol-${randomUUID()}`
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
        } else if (message.method === "thread-stream-following-changed") {
          socket.write(frame({
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "test-client",
            params: {
              conversationId: "thread-1",
              change: { type: "snapshot", revision: 1 },
            },
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
    await protocol.follow("thread-1");
    await protocol.inject({
      kind: "steer",
      threadId: "thread-1",
      expectedTurnId: "turn-active",
      clientUserMessageId: "delivery-1",
      input: [
        { type: "text", text: "steered " },
        { type: "image", url: "ignored" },
        { type: "text", text: "message" },
      ],
      createdAt: 123,
    });
    assert.equal(observed?.expectedTurnId, "turn-active");
    assert.equal(observed?.clientUserMessageId, "delivery-1");
    assert.deepEqual(observed?.restoreMessage, {
      id: "delivery-1",
      text: "steered message",
      context: {
        prompt: "steered message",
        addedFiles: [],
        fileAttachments: [],
        ideContext: null,
        imageAttachments: [],
        workspaceRoots: [],
      },
      cwd: null,
      createdAt: 123,
    });
    assert.equal("turnId" in (observed ?? {}), false);
    protocol.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Desktop broadcasts decode state deltas and delivery identities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-protocol-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\codexhook-protocol-${randomUUID()}`
    : path.join(directory, "ipc.sock");
  const sockets = new Set<net.Socket>();
  let client: net.Socket | undefined;
  const server = net.createServer((socket) => {
    client = socket;
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
      ) as { readonly requestId?: string; readonly method?: string };
      buffered = buffered.subarray(length + 4);
      if (message.method === "initialize") {
        socket.write(frame({
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          result: { clientId: "test-client" },
        }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const protocol = await DesktopIpcProtocol.connect(socketPath);
    const changes = new Promise<ReadonlyArray<DesktopTaskChange>>((resolve) => {
      const observed: DesktopTaskChange[] = [];
      protocol.onChange((_threadId, change) => {
        observed.push(change);
        if (observed.length === 2) resolve(observed);
      });
    });
    client?.write(frame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      params: {
        conversationId: "thread-1",
        change: {
          type: "snapshot",
          revision: 4,
          conversationState: {
            turnHistory: {
              history: {
                entitiesByKey: {
                  active: {
                    turnId: "turn-1",
                    status: "inProgress",
                    error: null,
                    message: { clientUserMessageId: "leaf-delivery" },
                    messages: [
                      { clientUserMessageId: "array-delivery" },
                      { nested: { clientUserMessageId: "nested-delivery" } },
                    ],
                  },
                },
              },
            },
            clientUserMessageId: "outside-entities",
          },
        },
      },
    }));
    client?.write(frame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      params: {
        conversationId: "thread-1",
        change: {
          type: "patches",
          baseRevision: 4,
          revision: 5,
          patches: [
            {
              op: "replace",
              path: ["turnHistory", "history", "entitiesByKey", "active", "status"],
              value: "completed",
            },
            {
              op: "add",
              path: [
                "turnHistory",
                "history",
                "entitiesByKey",
                "active",
                "clientUserMessageId",
              ],
              value: "leaf-delivery",
            },
            {
              op: "add",
              path: [
                "turnHistory",
                "history",
                "entitiesByKey",
                "active",
                "messages",
              ],
              value: [
                { clientUserMessageId: "array-delivery" },
                { nested: { clientUserMessageId: "nested-delivery" } },
              ],
            },
            {
              op: "add",
              path: ["draft", "clientUserMessageId"],
              value: "outside-entities",
            },
          ],
        },
      },
    }));

    const [snapshot, patches] = await changes;
    assert.equal(snapshot?._tag, "Snapshot");
    assert.equal(patches?._tag, "Patches");
    if (snapshot?._tag !== "Snapshot" || patches?._tag !== "Patches") return;
    assert.equal(snapshot.revision, 4);
    assert.deepEqual(snapshot.entities, [{
      key: "active",
      turn: { id: "turn-1", status: "inProgress", error: null },
    }]);
    assert.equal(patches.baseRevision, 4);
    assert.equal(patches.revision, 5);
    assert.deepEqual(patches.deltas, [{
      _tag: "Status",
      key: "active",
      status: "completed",
    }]);
    const expectedDeliveries = [
      "array-delivery",
      "leaf-delivery",
      "nested-delivery",
    ];
    assert.deepEqual([...snapshot.deliveryIds].sort(), expectedDeliveries);
    assert.deepEqual([...patches.deliveryIds].sort(), expectedDeliveries);
    assert.deepEqual(
      snapshot.deliveryBindings?.map((value) => value.deliveryId).sort(),
      expectedDeliveries,
    );
    assert.deepEqual(
      patches.deliveryBindings?.map((value) => value.deliveryId).sort(),
      expectedDeliveries,
    );
    protocol.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function rejectedStart(error: string) {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      if (sendOwnerSnapshot(message, send)) return;
      if (message.method !== "thread-follower-start-turn") return;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error,
      });
    },
  );
  try {
    const protocol = await DesktopIpcProtocol.connect(endpoint.socketPath);
    try {
      await protocol.follow("thread-1");
      return await protocol.inject({
        kind: "start",
        threadId: "thread-1",
        clientUserMessageId: "delivery-1",
        input: [],
      });
    } finally {
      protocol.close();
    }
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
}

test("Desktop rejection truth distinguishes safe and unknown writes", async () => {
  assert.deepEqual(await rejectedStart("request-version-mismatch"), {
    _tag: "Rejected",
    reason: "request-version-mismatch",
    notWritten: true,
    confirmedNoSubmission: true,
  });
  assert.deepEqual(await rejectedStart("unexpected-owner-handler-failure"), {
    _tag: "Rejected",
    reason: "unknown",
    notWritten: false,
    confirmedNoSubmission: false,
  });
});
