import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopProtocolError,
  DesktopProtocolSession,
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

test("encodes every v1 operation with its compatibility-specific shape", async () => {
  const endpoint = await testEndpoint();
  const observed = new Map<string, unknown>();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      if (message.method != null) observed.set(message.method, message.params);
      if (message.type !== "request") return;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: message.method === "thread-follower-start-turn"
          ? { result: { turn: { id: "turn-start" } } }
          : {},
      });
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await session.followThread("thread-1");
    await session.loadCompleteHistory("thread-1", 1_000);
    await session.startTurn("thread-1", { input: "start" }, 1_000);
    const steer = await session.steerTurn(
      "thread-1",
      { input: "steer" },
      1_000,
    );
    assert.deepEqual(observed.get("thread-stream-following-changed"), {
      conversationId: "thread-1",
      following: true,
      hostId: "local",
    });
    assert.deepEqual(observed.get("thread-follower-load-complete-history"), {
      conversationId: "thread-1",
    });
    assert.deepEqual(observed.get("thread-follower-start-turn"), {
      conversationId: "thread-1",
      turnStartParams: { input: "start" },
    });
    assert.deepEqual(observed.get("thread-follower-steer-turn"), {
      conversationId: "thread-1",
      input: "steer",
    });
    assert.equal(
      steer.outcome._tag === "Accepted" && steer.outcome.value.turnId,
      null,
    );
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("reports an unknown result type as an explicit written incompatibility", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      if (message.method !== "thread-follower-start-turn") return;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "future-success",
        result: { result: { turn: { id: "turn-future" } } },
      });
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
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
    const observations: string[] = [];
    session.onObservation((observation) => observations.push(observation._tag));
    await assert.rejects(
      session.startTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "frame-invalid" &&
        error.writeState === "unknown",
    );
    assert.equal(observations.includes("Disconnected"), true);
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
      for (const message of pending.toReversed()) {
        const params = message.params as {
          turnStartParams?: { ordinal?: unknown };
        };
        const turnId = params.turnStartParams?.ordinal === 1
          ? "turn-first"
          : "turn-second";
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
  assert.equal(session.alive, true);

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
