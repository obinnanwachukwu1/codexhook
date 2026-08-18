import assert from "node:assert/strict";
import test from "node:test";
import { DesktopIpcProtocol } from "../src/transport/desktop-task-protocol.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

test("Desktop injection bounds a delivery budget to the request limit", async () => {
  const endpoint = await testEndpoint();
  let starts = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 1 },
          },
        });
      }
      if (message.method !== "thread-follower-start-turn") return;
      starts += 1;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: { result: { turnId: "turn-started" } },
      });
    },
  );
  try {
    const protocol = await DesktopIpcProtocol.connect(endpoint.socketPath);
    try {
      await protocol.follow("thread-1");
      const reply = await protocol.inject({
        kind: "start",
        threadId: "thread-1",
        clientUserMessageId: "delivery-1",
        input: [],
        createdAt: 1,
        timeoutMs: 30 * 60 * 1_000,
      });
      assert.equal(reply._tag, "Accepted");
      assert.equal(starts, 1);
    } finally {
      protocol.close();
    }
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("Desktop history uses the negotiated request timeout limit", async () => {
  const endpoint = await testEndpoint();
  let histories = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 1 },
          },
        });
      }
      if (message.method !== "thread-follower-load-complete-history") return;
      histories += 1;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: {},
      });
    },
  );
  try {
    const protocol = await DesktopIpcProtocol.connect(
      endpoint.socketPath,
      undefined,
      undefined,
      { handshakeTimeoutMs: 100, maxRequestTimeoutMs: 100 },
    );
    try {
      await protocol.follow("thread-1");
      assert.equal(await protocol.loadHistory("thread-1"), true);
      assert.equal(histories, 1);
    } finally {
      protocol.close();
    }
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});
