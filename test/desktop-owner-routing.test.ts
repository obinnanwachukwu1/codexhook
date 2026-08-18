import assert from "node:assert/strict";
import test from "node:test";
import { DesktopProtocolSession } from "../src/transport/desktop-ipc/index.js";
import { followDesktopThread } from
  "../src/transport/desktop-ipc/session-follow.js";
import { DesktopThreadOwners } from
  "../src/transport/desktop-ipc/thread-owners.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

test("targets followed task operations to the state snapshot owner", async () => {
  const endpoint = await testEndpoint();
  const targets: Array<string | undefined> = [];
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner-1",
          version: 11,
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 1 },
          },
        });
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "spoofed-owner",
          version: 11,
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 2 },
          },
        });
        return;
      }
      if (message.method !== "thread-follower-steer-turn") return;
      targets.push(message.targetClientId);
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: {},
      });
    },
    {
      afterInitialize: (send) => {
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "unfollowed-claim",
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 0 },
          },
        });
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "malformed-claim",
          params: {
            conversationId: "thread-1",
            change: { type: "not-a-real-change" },
          },
        });
      },
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await session.followThread("thread-1");
    await session.steerTurn("thread-1", { input: [] }, 1_000);
    assert.deepEqual(targets, ["desktop-owner-1"]);
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("never writes an unfollowed task mutation", async () => {
  const endpoint = await testEndpoint();
  let mutations = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message) => {
      if (
        message.method === "thread-follower-start-turn" ||
        message.method === "thread-follower-steer-turn"
      ) mutations += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await assert.rejects(
      session.startTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof Error &&
        "failure" in error &&
        error.failure === "task-not-followed" &&
        "writeState" in error &&
        error.writeState === "not-written",
    );
    await assert.rejects(
      session.steerTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof Error &&
        "failure" in error &&
        error.failure === "task-not-followed",
    );
    assert.equal(mutations, 0);
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("a failed repeated follow preserves existing owner state", async () => {
  const followed = new Set(["thread-1"]);
  const owners = new DesktopThreadOwners();
  owners.observe({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-1",
      change: { type: "snapshot", revision: 1 },
    },
  }, followed);
  await assert.rejects(followDesktopThread({
    adapter: {
      methods: { follow: "follow", history: "history", start: "start", steer: "steer" },
      version: 1,
      followParams: () => ({}),
    },
    raw: {
      broadcast: async () => {
        throw new Error("synthetic write failure");
      },
    },
  }, followed, owners, "thread-1"));
  assert.equal(followed.has("thread-1"), true);
  assert.equal(owners.target("thread-1"), "desktop-owner");
});

test("a closed owner registry rejects later waiters immediately", async () => {
  const owners = new DesktopThreadOwners();
  owners.close();
  assert.equal(await owners.wait("thread-1", 120_000), null);
});

test("close wakes every pending owner waiter without writing", async () => {
  const endpoint = await testEndpoint();
  let mutations = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message) => {
      if (
        message.method === "thread-follower-start-turn" ||
        message.method === "thread-follower-steer-turn"
      ) mutations += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await session.followThread("thread-1");
    const pending = [
      session.startTurn("thread-1", {}, 1_000),
      session.steerTurn("thread-1", {}, 1_000),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    session.close();
    const results = await Promise.allSettled(pending);
    assert.deepEqual(results.map((result) => result.status), [
      "rejected",
      "rejected",
    ]);
    assert.equal(mutations, 0);
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("disconnect wakes pending owner waiters without writing", async () => {
  const endpoint = await testEndpoint();
  let mutations = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message) => {
      if (message.method === "thread-follower-start-turn") mutations += 1;
    },
  );
  const session = await DesktopProtocolSession.connect(endpoint.socketPath);
  try {
    await session.followThread("thread-1");
    const pending = session.startTurn("thread-1", {}, 1_000);
    await new Promise((resolve) => setImmediate(resolve));
    await router.close();
    await assert.rejects(pending, (error: unknown) =>
      error instanceof Error &&
      "failure" in error &&
      error.failure === "request-timeout"
    );
    assert.equal(mutations, 0);
  } finally {
    session.close();
    await endpoint.cleanup();
  }
});

test("never writes a followed task without snapshot owner evidence", async () => {
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
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 1 },
          },
        });
        return;
      }
      if (message.method === "thread-follower-start-turn") starts += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await session.followThread("thread-1");
    const began = Date.now();
    await assert.rejects(
      session.startTurn("thread-1", {}, 30 * 60 * 1_000),
      (error: unknown) =>
        error instanceof Error &&
        "failure" in error &&
        error.failure === "request-timeout" &&
        "writeState" in error &&
        error.writeState === "not-written",
    );
    assert.equal(Date.now() - began < 250, true);
    assert.equal(starts, 0);
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("routing rejection requires fresh owner evidence before another write", async () => {
  const endpoint = await testEndpoint();
  let publish!: (owner: string) => void;
  let starts = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      publish = (owner) => send({
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: owner,
        params: {
          conversationId: "thread-1",
          change: { type: "snapshot", revision: starts + 1 },
        },
      });
      if (message.method === "thread-stream-following-changed") {
        publish("desktop-owner-1");
        return;
      }
      if (message.method === "thread-follower-load-complete-history") {
        assert.equal(message.targetClientId, undefined);
        publish("desktop-owner-2");
        send({
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          result: {},
        });
        return;
      }
      if (message.method !== "thread-follower-start-turn") return;
      starts += 1;
      assert.equal(
        message.targetClientId,
        starts === 1 ? "desktop-owner-1" : "desktop-owner-2",
      );
      send(starts === 1
        ? {
            type: "response",
            requestId: message.requestId,
            resultType: "error",
            error: "client-not-found",
          }
        : {
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: { result: { turnId: "turn-2" } },
          });
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await session.followThread("thread-1");
    const rejected = await session.startTurn("thread-1", {}, 1_000);
    assert.equal(rejected.outcome._tag, "Rejected");
    await assert.rejects(session.startTurn("thread-1", {}, 30));
    assert.equal(starts, 1);
    const history = await session.loadCompleteHistory("thread-1", 1_000);
    assert.equal(history.outcome._tag, "Accepted");
    const accepted = await session.startTurn("thread-1", {}, 1_000);
    assert.equal(accepted.outcome._tag, "Accepted");
    assert.equal(starts, 2);
    session.close();
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});
