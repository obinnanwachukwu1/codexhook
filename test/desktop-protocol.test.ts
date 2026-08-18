import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopFrameDecoder,
  DesktopProtocolError,
  DesktopProtocolSession,
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
  encodeDesktopFrame,
} from "../src/transport/desktop-ipc/index.js";
import type { DesktopWireEnvelope } from "../src/transport/desktop-ipc/index.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

test("selects legacy and explicit v1 adapters across response shapes", async () => {
  for (const entry of [
    {
      initialize: "initialize-legacy.json",
      start: "start-legacy.json",
      adapterId: "desktop-ipc/v1-legacy",
      turnId: "turn-legacy",
    },
    {
      initialize: "initialize-v1.json",
      start: "start-v1.json",
      adapterId: "desktop-ipc/v1",
      turnId: "turn-versioned",
    },
  ]) {
    const endpoint = await testEndpoint();
    const start = await fixture(entry.start);
    const router = await listen(
      endpoint.socketPath,
      await fixture(entry.initialize),
      (message, send) => {
        if (message.method === "thread-follower-start-turn") {
          send({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: start,
          });
        }
      },
    );
    try {
      const session = await DesktopProtocolSession.connect(endpoint.socketPath);
      assert.equal(session.profile.fingerprint.adapterId, entry.adapterId);
      assert.equal(session.profile.fingerprint.digest.length, 24);
      const receipt = await session.startTurn("thread-1", {}, 1_000);
      assert.equal(receipt.outcome._tag, "Accepted");
      if (receipt.outcome._tag === "Accepted") {
        assert.equal(receipt.outcome.value.turnId, entry.turnId);
      }
      session.close();
    } finally {
      await router.close();
      await endpoint.cleanup();
    }
  }
});

test("preserves the minimal handshake and legacy success response semantics", async () => {
  const endpoint = await testEndpoint();
  let initializeParams: unknown;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      if (message.method === "thread-follower-start-turn") {
        send({
          type: "response",
          method: "normalized-start-name",
          requestId: message.requestId,
          result: { result: { turn: { id: "turn-no-result-type" } } },
        });
      }
    },
    {
      onInitialize: (message) => {
        initializeParams = message.params;
      },
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    assert.deepEqual(initializeParams, { clientType: "codexhook" });
    const receipt = await session.startTurn("thread-1", {}, 1_000);
    assert.equal(
      receipt.outcome._tag === "Accepted" && receipt.outcome.value.turnId,
      "turn-no-result-type",
    );
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

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

test("fails an in-flight request when the router sends a malformed frame", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, _send, sendRaw) => {
      if (message.method === "thread-follower-start-turn") {
        sendRaw(Buffer.alloc(4));
      }
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await assert.rejects(
      session.startTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "frame-invalid" &&
        error.writeState === "unknown",
    );
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("times out without retrying an uncertain request", async () => {
  const endpoint = await testEndpoint();
  let starts = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message) => {
      if (message.method === "thread-follower-start-turn") starts += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await assert.rejects(
      session.startTurn("thread-1", {}, 20),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "request-timeout" &&
        error.writeState === "unknown",
    );
    assert.equal(starts, 1);
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("correlates concurrent responses that arrive out of order", async () => {
  const endpoint = await testEndpoint();
  const pending: DesktopWireEnvelope[] = [];
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      pending.push(message);
      if (pending.length !== 2) return;
      for (const [message, turnId] of [
        [pending[1], "turn-second"],
        [pending[0], "turn-first"],
      ] as const) {
        send({
          type: "response",
          requestId: message?.requestId,
          resultType: "success",
          result: { result: { turn: { id: turnId } } },
        });
      }
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    const [first, second] = await Promise.all([
      session.startTurn("thread-1", { ordinal: 1 }, 1_000),
      session.startTurn("thread-1", { ordinal: 2 }, 1_000),
    ]);
    assert.equal(
      first.outcome._tag === "Accepted" && first.outcome.value.turnId,
      "turn-first",
    );
    assert.equal(
      second.outcome._tag === "Accepted" && second.outcome.value.turnId,
      "turn-second",
    );
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("reconnects future operations after socket replacement without replay", async () => {
  const endpoint = await testEndpoint();
  const initialize = await fixture("initialize-legacy.json");
  const firstRouter = await listen(endpoint.socketPath, initialize);
  const session = await DesktopProtocolSession.connect(endpoint.socketPath);
  const observations: string[] = [];
  session.onObservation((observation) => observations.push(observation._tag));
  await session.followThread("thread-1");
  await firstRouter.close();

  let starts = 0;
  let follows = 0;
  const secondRouter = await listen(
    endpoint.socketPath,
    initialize,
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        follows += 1;
        return;
      }
      if (message.method !== "thread-follower-start-turn") return;
      starts += 1;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: { result: { turn: { id: "turn-reconnected" } } },
      });
    },
  );
  try {
    const receipt = await session.startTurn("thread-1", {}, 1_000);
    assert.equal(
      receipt.outcome._tag === "Accepted" && receipt.outcome.value.turnId,
      "turn-reconnected",
    );
    assert.equal(starts, 1);
    assert.equal(follows, 1);
    assert.equal(observations.includes("Reconnected"), true);
  } finally {
    session.close();
    await secondRouter.close();
    await endpoint.cleanup();
  }
});

test("rejects an unadvertised capability before writing operation bytes", async () => {
  const endpoint = await testEndpoint();
  let starts = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-limited.json"),
    (message) => {
      if (message.method === "thread-follower-start-turn") starts += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await assert.rejects(
      session.startTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "unsupported-capability" &&
        error.writeState === "not-written",
    );
    assert.equal(starts, 0);
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});
