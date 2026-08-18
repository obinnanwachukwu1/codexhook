import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopProtocolError,
  DesktopProtocolSession,
} from "../src/transport/desktop-ipc/index.js";
import {
  DesktopFrameDecoder,
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
  encodeDesktopFrame,
} from "../src/transport/desktop-ipc/framing.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

test("rejects an explicitly unknown protocol version", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-unknown.json"),
  );
  try {
    await assert.rejects(
      DesktopProtocolSession.connect(endpoint.socketPath),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "unknown-protocol-version",
    );
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("rejects malformed handshake fields explicitly", async () => {
  for (const initialize of [
    {},
    { clientId: "desktop-client", serverCapabilities: "invalid" },
    { clientId: "desktop-client", protocolVersion: 1.5 },
  ]) {
    const endpoint = await testEndpoint();
    const router = await listen(endpoint.socketPath, initialize);
    try {
      await assert.rejects(
        DesktopProtocolSession.connect(endpoint.socketPath),
        (error: unknown) =>
          error instanceof DesktopProtocolError &&
          error.failure === "handshake-malformed",
      );
    } finally {
      await router.close();
      await endpoint.cleanup();
    }
  }
});

test("rejects an unknown initialize result type explicitly", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    undefined,
    { initializeResultType: "future-success" },
  );
  try {
    await assert.rejects(
      DesktopProtocolSession.connect(endpoint.socketPath),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "handshake-malformed",
    );
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("rejects oversized outbound requests before the write barrier", async () => {
  const endpoint = await testEndpoint();
  let starts = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        send(ownerSnapshot("thread-1"));
      }
      if (message.method === "thread-follower-start-turn") starts += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath, {
      maxOutboundFrameBytes: 512,
    });
    await session.followThread("thread-1");
    await assert.rejects(
      session.startTurn("thread-1", { input: "x".repeat(1_024) }, 1_000),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "frame-invalid" &&
        error.writeState === "not-written",
    );
    assert.equal(starts, 0);
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("bounds and rejects malformed frame lengths, JSON, and envelopes", () => {
  assert.equal(DEFAULT_MAX_INBOUND_FRAME_BYTES, 256 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_OUTBOUND_FRAME_BYTES, 16 * 1024 * 1024);
  const combined = Buffer.concat([
    encodeDesktopFrame({ type: "broadcast", params: "a".repeat(120) }),
    encodeDesktopFrame({ type: "broadcast", params: "b".repeat(120) }),
  ]);
  assert.equal(combined.length > 260, true);
  assert.equal(new DesktopFrameDecoder(256).push(combined).length, 2);

  const zeroLength = Buffer.alloc(4);
  assert.throws(
    () => new DesktopFrameDecoder(64).push(zeroLength),
    DesktopProtocolError,
  );

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(65);
  assert.throws(
    () => new DesktopFrameDecoder(64).push(oversized),
    DesktopProtocolError,
  );

  const invalidJson = Buffer.concat([
    Buffer.from([1, 0, 0, 0]),
    Buffer.from("{"),
  ]);
  assert.throws(
    () => new DesktopFrameDecoder(64).push(invalidJson),
    DesktopProtocolError,
  );
  let malformedEnvelopes = 0;
  const decoder = new DesktopFrameDecoder(64, () => {
    malformedEnvelopes += 1;
  });
  assert.deepEqual(decoder.push(encodeDesktopFrame([])), []);
  const [badSource] = decoder.push(
    encodeDesktopFrame({ type: "broadcast", sourceClientId: 42 }),
  );
  const [badTarget] = decoder.push(
    encodeDesktopFrame({ type: "request", targetClientId: "" }),
  );
  assert.equal(badSource?.type, "broadcast");
  assert.equal(badSource?.sourceClientId, undefined);
  assert.equal(badTarget?.type, "request");
  assert.equal(badTarget?.targetClientId, undefined);
  assert.equal(malformedEnvelopes, 1);
});

test("malformed JSON diagnostics do not retain frame contents", () => {
  const body = Buffer.from('{"message":"private-conversation-text"');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  assert.throws(
    () => new DesktopFrameDecoder().push(frame),
    (error: unknown) => {
      assert.equal(error instanceof DesktopProtocolError, true);
      assert.equal(String(error).includes("private-conversation-text"), false);
      assert.equal((error as Error).cause, undefined);
      return true;
    },
  );
});

test("owns incomplete frame bytes instead of aliasing caller memory", () => {
  const frame = encodeDesktopFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
  });
  const firstFragment = Buffer.from(frame.subarray(0, 3));
  const decoder = new DesktopFrameDecoder();
  assert.deepEqual(decoder.push(firstFragment), []);

  firstFragment.fill(0xff);

  const [message] = decoder.push(frame.subarray(3));
  assert.equal(message?.method, "thread-stream-state-changed");
});

test("does not infer a started turn from historical snapshot entities", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        send(ownerSnapshot("thread-1"));
      }
      if (message.method !== "thread-follower-start-turn") return;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: {
          conversationState: {
            turnHistory: {
              history: {
                entitiesByKey: {
                  old: { turnId: "turn-old", status: "completed" },
                },
              },
            },
          },
        },
      });
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await session.followThread("thread-1");
    await assert.rejects(
      session.startTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "response-malformed" &&
        error.writeState === "written",
    );
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

function ownerSnapshot(threadId: string) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: threadId,
      change: { type: "snapshot", revision: 1 },
    },
  };
}
