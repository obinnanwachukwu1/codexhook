import assert from "node:assert/strict";
import test from "node:test";
import { DesktopProtocolSession } from "../src/transport/desktop-ipc/index.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

test("targets followed task operations to the state snapshot owner", async () => {
  const endpoint = await testEndpoint();
  let targetClientId: string | undefined;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      if (message.method !== "thread-follower-steer-turn") return;
      targetClientId = message.targetClientId;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: {},
      });
    },
    {
      afterInitialize: (send) => send({
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "desktop-owner-1",
        version: 11,
        params: {
          conversationId: "thread-1",
          change: { type: "snapshot", revision: 1 },
        },
      }),
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await session.steerTurn("thread-1", { input: [] }, 1_000);
    assert.equal(targetClientId, "desktop-owner-1");
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});
