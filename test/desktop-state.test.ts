import assert from "node:assert/strict";
import test from "node:test";
import { DesktopThreadState } from "../src/transport/desktop-state.js";

const emptyHistory = {
  turnHistory: { history: { entitiesByKey: {} } },
};

function snapshot(
  revision: number,
  entitiesByKey: Record<string, unknown> = {},
) {
  return {
    type: "snapshot",
    revision,
    conversationState: {
      turnHistory: { history: { entitiesByKey } },
    },
  } as const;
}

test("moves from disconnected through following to synchronized activity", () => {
  const state = new DesktopThreadState("thread-1");
  assert.deepEqual(state.evidence(), {
    connection: "disconnected",
    attachment: "detached",
    activity: "unknown",
    injection: "idle",
    generation: 0,
    revision: null,
    turns: [],
  });

  state.beginConnecting();
  assert.equal(state.evidence().connection, "connecting");
  state.beginFollowing(3);
  assert.equal(state.evidence().attachment, "following");
  assert.equal(state.apply(snapshot(1), 3), "applied");
  assert.equal(state.evidence().activity, "idle");

  assert.equal(state.apply({
    type: "patches",
    baseRevision: 1,
    revision: 2,
    patches: [{
      op: "add",
      path: ["turnHistory", "history", "entitiesByKey", "first"],
      value: { turnId: "turn-1", status: "inProgress", error: null },
    }],
  }, 3), "applied");
  assert.equal(state.evidence().activity, "active");
  assert.equal(state.turn("turn-1")?.status, "inProgress");
});

test("applies status and error patches at a fenced revision", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(1);
  state.apply(snapshot(4, {
    first: { turnId: "turn-1", status: "inProgress", error: null },
  }), 1);
  state.apply({
    type: "patches",
    baseRevision: 4,
    revision: 5,
    patches: [
      {
        op: "replace",
        path: [
          "turnHistory", "history", "entitiesByKey", "first", "status",
        ],
        value: "failed",
      },
      {
        op: "replace",
        path: [
          "turnHistory", "history", "entitiesByKey", "first", "error",
        ],
        value: { message: "boom" },
      },
    ],
  }, 1);
  assert.deepEqual(state.turn("turn-1"), {
    id: "turn-1",
    status: "failed",
    error: { message: "boom" },
  });
  assert.equal(state.evidence().activity, "idle");
});

test("rejects revision gaps and recovers only from a complete snapshot", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(1);
  state.apply(snapshot(4), 1);
  assert.equal(state.apply({
    type: "patches",
    baseRevision: 2,
    revision: 5,
    patches: [{
      op: "add",
      path: ["turnHistory", "history", "entitiesByKey", "wrong"],
      value: { turnId: "turn-wrong", status: "completed" },
    }],
  }, 1), "resync");
  assert.equal(state.ready, false);
  assert.equal(state.turn("turn-wrong"), undefined);

  assert.equal(state.apply({
    type: "patches",
    baseRevision: 4,
    revision: 5,
    patches: [],
  }, 1), "resync");
  assert.equal(state.apply({
    type: "snapshot",
    revision: 6,
    conversationState: emptyHistory,
  }, 1), "applied");
  assert.equal(state.ready, true);
  assert.equal(state.revision, 6);
});

test("ignores stale revisions and events from a prior connection", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(7);
  state.apply(snapshot(10), 7);
  assert.equal(state.apply({
    type: "patches",
    baseRevision: 8,
    revision: 9,
    patches: [],
  }, 7), "ignored");
  assert.equal(state.apply(snapshot(11, {
    stale: { turnId: "stale", status: "completed" },
  }), 6), "ignored");
  assert.equal(state.revision, 10);
  assert.equal(state.turn("stale"), undefined);
});

test("marks an in-flight injection uncertain on disconnect", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(1);
  state.apply(snapshot(1), 1);
  state.beginInjection();
  assert.equal(state.evidence().injection, "injecting");
  state.disconnected();
  assert.equal(state.evidence().injection, "uncertain");
  assert.equal(state.evidence().activity, "unknown");
});
