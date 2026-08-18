import assert from "node:assert/strict";
import test from "node:test";
import { DesktopThreadState } from "../src/transport/desktop-state.js";

function snapshot(
  revision: number,
  entitiesByKey: Record<string, unknown> = {},
) {
  return {
    _tag: "Snapshot",
    revision,
    entities: Object.entries(entitiesByKey).map(([key, value]) => {
      const turn = value as {
        turnId: string;
        status: "inProgress" | "completed" | "interrupted" | "failed";
        error: null | { message?: string };
      };
      return {
        key,
        turn: { id: turn.turnId, status: turn.status, error: turn.error },
      };
    }),
    deliveryIds: [],
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
    _tag: "Patches",
    baseRevision: 1,
    revision: 2,
    deltas: [{
      _tag: "Upsert",
      entity: {
        key: "first",
        turn: { id: "turn-1", status: "inProgress", error: null },
      },
    }],
    deliveryIds: [],
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
    _tag: "Patches",
    baseRevision: 4,
    revision: 5,
    deltas: [
      {
        _tag: "Status",
        key: "first",
        status: "failed",
      },
      {
        _tag: "Error",
        key: "first",
        error: { message: "boom" },
      },
    ],
    deliveryIds: [],
  }, 1);
  assert.deepEqual(state.turn("turn-1"), {
    id: "turn-1",
    status: "failed",
    error: { message: "boom" },
  });
  assert.equal(state.evidence().activity, "idle");
});

test("replaces an entity binding without retaining an orphaned active turn", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(1);
  state.apply(snapshot(1, {
    active: { turnId: "temporary", status: "inProgress", error: null },
  }), 1);
  state.apply({
    _tag: "Patches",
    baseRevision: 1,
    revision: 2,
    deltas: [{ _tag: "Bind", key: "active", turnId: "canonical" }],
    deliveryIds: [],
  }, 1);
  state.apply({
    _tag: "Patches",
    baseRevision: 2,
    revision: 3,
    deltas: [{ _tag: "Status", key: "active", status: "completed" }],
    deliveryIds: [],
  }, 1);

  assert.equal(state.turn("temporary"), undefined);
  assert.equal(state.activeTurn(), undefined);
  assert.deepEqual(state.turnsSnapshot(), [{
    id: "canonical",
    status: "completed",
    error: null,
  }]);
});

test("rejects revision gaps and recovers only from a complete snapshot", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(1);
  state.apply(snapshot(4), 1);
  assert.equal(state.apply({
    _tag: "Patches",
    baseRevision: 2,
    revision: 5,
    deltas: [{
      _tag: "Upsert",
      entity: {
        key: "wrong",
        turn: { id: "turn-wrong", status: "completed", error: null },
      },
    }],
    deliveryIds: [],
  }, 1), "resync");
  assert.equal(state.ready, false);
  assert.equal(state.turn("turn-wrong"), undefined);

  assert.equal(state.apply({
    _tag: "Patches",
    baseRevision: 4,
    revision: 5,
    deltas: [],
    deliveryIds: [],
  }, 1), "resync");
  assert.equal(state.apply({
    _tag: "Snapshot",
    revision: 6,
    entities: [],
    deliveryIds: [],
  }, 1), "applied");
  assert.equal(state.ready, true);
  assert.equal(state.revision, 6);
});

test("ignores stale revisions and events from a prior connection", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(7);
  state.apply(snapshot(10, {
    current: { turnId: "current", status: "completed", error: null },
  }), 7);
  assert.equal(state.apply({
    _tag: "Patches",
    baseRevision: 8,
    revision: 9,
    deltas: [],
    deliveryIds: [],
  }, 7), "ignored");
  assert.equal(state.apply(snapshot(9, {
    stale: { turnId: "stale", status: "completed", error: null },
  }), 7), "ignored");
  assert.equal(state.apply(snapshot(11, {
    priorGeneration: {
      turnId: "prior-generation",
      status: "completed",
      error: null,
    },
  }), 6), "ignored");
  assert.equal(state.revision, 10);
  assert.equal(state.turn("stale"), undefined);
  assert.equal(state.turn("current")?.status, "completed");
  state.beginFollowing(8);
  assert.equal(state.turn("current"), undefined);
  assert.equal(state.turnsSnapshot().length, 0);
});

test("marks an in-flight injection uncertain on disconnect", () => {
  const state = new DesktopThreadState("thread-1");
  state.beginFollowing(1);
  state.apply(snapshot(1), 1);
  state.setInjection("injecting");
  assert.equal(state.evidence().injection, "injecting");
  state.disconnected();
  assert.equal(state.evidence().injection, "uncertain");
  assert.equal(state.evidence().activity, "unknown");
});
