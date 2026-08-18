import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import test from "node:test";
import {
  DesktopProtocolError,
  DesktopProtocolSession,
} from "../src/transport/desktop-ipc/index.js";
import type { DesktopProtocolObservation } from "../src/transport/desktop-ipc/index.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test("detects a live Unix socket replacement and re-follows before use", {
  skip: process.platform === "win32",
}, async () => {
  const endpoint = await testEndpoint();
  const initialize = await fixture("initialize-legacy.json");
  const firstRouter = await listen(endpoint.socketPath, initialize);
  const session = await DesktopProtocolSession.connect(endpoint.socketPath);
  await session.followThread("thread-1");
  await unlink(endpoint.socketPath);

  const methods: string[] = [];
  const secondRouter = await listen(
    endpoint.socketPath,
    initialize,
    (message, send) => {
      if (message.method != null) methods.push(message.method);
      if (message.method === "thread-follower-start-turn") {
        send({
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          result: { result: { turn: { id: "turn-rotated" } } },
        });
      }
    },
  );
  try {
    const receipt = await session.startTurn("thread-1", {}, 1_000);
    assert.equal(
      receipt.outcome._tag === "Accepted" && receipt.outcome.value.turnId,
      "turn-rotated",
    );
    assert.deepEqual(methods, [
      "thread-stream-following-changed",
      "thread-follower-start-turn",
    ]);
  } finally {
    session.close();
    await secondRouter.close();
    await firstRouter.close();
    await endpoint.cleanup();
  }
});

test("closing during reconnect cannot resurrect or leak a session", async () => {
  const endpoint = await testEndpoint();
  const initialize = await fixture("initialize-legacy.json");
  const firstRouter = await listen(endpoint.socketPath, initialize);
  const session = await DesktopProtocolSession.connect(endpoint.socketPath);
  await firstRouter.close();

  let connected!: () => void;
  const connection = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let starts = 0;
  const secondRouter = await listen(
    endpoint.socketPath,
    initialize,
    (message) => {
      if (message.method === "thread-follower-start-turn") starts += 1;
    },
    { initializeDelayMs: 40, onConnection: connected },
  );
  try {
    const pending = session.startTurn("thread-1", {}, 1_000);
    await connection;
    session.close();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof DesktopProtocolError && error.failure === "closed",
    );
    await waitFor(() => secondRouter.socketCount() === 0);
    assert.equal(session.alive, false);
    assert.equal(secondRouter.socketCount(), 0);
    assert.equal(starts, 0);
  } finally {
    session.close();
    await secondRouter.close();
    await endpoint.cleanup();
  }
});

test("responds to discovery and reports sanitized lifecycle observations", async () => {
  const endpoint = await testEndpoint();
  let discovery!: (value: unknown) => void;
  const discovered = new Promise<unknown>((resolve) => {
    discovery = resolve;
  });
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      if (message.type === "client-discovery-response") {
        discovery((message as unknown as { response?: unknown }).response);
      }
      if (message.method === "thread-follower-start-turn") {
        send({
          type: "response",
          requestId: "orphan-request",
          resultType: "success",
          result: {},
        });
        send([]);
        send({ type: "broadcast" });
        send({
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          result: { result: { turn: { id: "turn-observed" } } },
        });
      }
    },
    {
      afterInitialize: (send) => send({
        type: "client-discovery-request",
        requestId: "discovery-request",
      }),
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    assert.deepEqual(await discovered, { canHandle: false });
    const observations: DesktopProtocolObservation[] = [];
    session.onObservation((observation) => observations.push(observation));
    await session.startTurn("thread-1", {}, 1_000);
    session.close();
    assert.deepEqual(new Set(observations.map((item) => item._tag)), new Set([
      "MalformedEnvelope",
      "OrphanResponse",
      "MalformedBroadcast",
      "Disconnected",
    ]));
    assert.equal(JSON.stringify(observations).includes("turn-observed"), false);
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("enforces pending and timeout bounds before writing extra bytes", async () => {
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
    const session = await DesktopProtocolSession.connect(endpoint.socketPath, {
      maxPendingRequests: 1,
    });
    const pending = session.startTurn("thread-1", {}, 30);
    await assert.rejects(
      session.startTurn("thread-1", {}, 30),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "pending-limit" &&
        error.writeState === "not-written",
    );
    await assert.rejects(pending, DesktopProtocolError);
    await assert.rejects(
      session.startTurn("thread-1", {}, 0),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "invalid-timeout" &&
        error.writeState === "not-written",
    );
    assert.equal(starts, 1);
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});
