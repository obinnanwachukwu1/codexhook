import assert from "node:assert/strict";
import test from "node:test";
import { DesktopThreadState } from "../src/transport/desktop-state.js";
import { desktopStateChange } from "./fixtures/desktop-state.js";

const threadId = "thread-1";

function stateChange(change: unknown) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    params: {
      conversationId: threadId,
      hostId: "local",
      change,
    },
  } as const;
}

test("tracks Desktop turns across snapshots and incremental patches", () => {
  const state = new DesktopThreadState(threadId);
  state.apply(
    stateChange({
      type: "snapshot",
      conversationState: {
        turnHistory: {
          history: {
            entitiesByKey: {
              first: {
                turnId: "turn-1",
                status: "inProgress",
                error: null,
              },
            },
          },
        },
      },
    }),
  );
  assert.equal(state.ready, true);
  assert.equal(state.turn("turn-1")?.status, "inProgress");

  state.apply(
    stateChange({
      type: "patches",
      baseRevision: 1,
      revision: 2,
      patches: [
        {
          op: "replace",
          path: [
            "turnHistory",
            "history",
            "entitiesByKey",
            "first",
            "status",
          ],
          value: "completed",
        },
      ],
    }),
  );
  assert.equal(state.turn("turn-1")?.status, "completed");
});

test("associates a new entity when its turn id arrives later", () => {
  const state = new DesktopThreadState(threadId);
  state.apply(
    stateChange({
      type: "patches",
      patches: [
        {
          op: "replace",
          path: [
            "turnHistory",
            "history",
            "entitiesByKey",
            "later",
            "turnId",
          ],
          value: "turn-2",
        },
        {
          op: "replace",
          path: [
            "turnHistory",
            "history",
            "entitiesByKey",
            "later",
            "status",
          ],
          value: "failed",
        },
      ],
    }),
  );
  assert.equal(state.turn("turn-2")?.status, "failed");
});

test("rejects a revision gap and requests a fresh snapshot", () => {
  const state = new DesktopThreadState(threadId);
  state.apply(
    stateChange({
      type: "snapshot",
      revision: 4,
      conversationState: {
        turnHistory: { history: { entitiesByKey: {} } },
      },
    }),
  );
  state.apply(
    stateChange({
      type: "patches",
      baseRevision: 2,
      revision: 3,
      patches: [
        {
          op: "add",
          path: [
            "turnHistory",
            "history",
            "entitiesByKey",
            "wrong",
          ],
          value: { turnId: "turn-wrong", status: "completed" },
        },
      ],
    }),
  );
  assert.equal(state.ready, false);
  assert.equal(state.turn("turn-wrong"), undefined);
  assert.equal(state.takeResyncRequest(), true);
  assert.equal(state.takeResyncRequest(), false);
});

test("applies reordered entity patches without inventing an active turn", () => {
  const diagnostics: string[] = [];
  const state = new DesktopThreadState(threadId, (event) => {
    diagnostics.push(event);
  });
  state.apply(desktopStateChange({
    type: "patches",
    patches: [
      {
        op: "replace",
        path: ["turnHistory", "history", "entitiesByKey", "late", "status"],
        value: "completed",
      },
      {
        op: "replace",
        path: ["turnHistory", "history", "entitiesByKey", "late", "turnId"],
        value: "turn-reordered",
      },
    ],
  }));
  assert.equal(state.turn("turn-reordered")?.status, "completed");
  assert.deepEqual(diagnostics, ["reordered_patch"]);
});

test("a repeated turn association preserves a completed turn", () => {
  const state = new DesktopThreadState(threadId);
  state.apply(desktopStateChange({
    type: "snapshot",
    revision: 1,
    conversationState: {
      turnHistory: { history: { entitiesByKey: {
        known: { turnId: "turn-complete", status: "completed" },
      } } },
    },
  }));
  state.apply(desktopStateChange({
    type: "patches",
    baseRevision: 1,
    revision: 2,
    patches: [{
      op: "replace",
      path: ["turnHistory", "history", "entitiesByKey", "known", "turnId"],
      value: "turn-complete",
    }],
  }));
  assert.equal(state.turn("turn-complete")?.status, "completed");
});

test("fresh snapshots clear stale active turns and complete resynchronization", () => {
  const diagnostics: string[] = [];
  const state = new DesktopThreadState(threadId, (event) => {
    diagnostics.push(event);
  });
  state.apply(desktopStateChange({
    type: "snapshot",
    revision: 1,
    conversationState: {
      turnHistory: { history: { entitiesByKey: {
        active: { turnId: "turn-stale", status: "inProgress" },
      } } },
    },
  }));
  state.apply(desktopStateChange({
    type: "patches",
    baseRevision: 8,
    revision: 9,
    patches: [],
  }));
  assert.equal(state.takeResyncRequest(), true);
  state.apply(desktopStateChange({
    type: "snapshot",
    revision: 10,
    conversationState: {
      turnHistory: { history: { entitiesByKey: {} } },
    },
  }));
  assert.equal(state.ready, true);
  assert.equal(state.turn("turn-stale"), undefined);
  assert.deepEqual(diagnostics, [
    "revision_gap",
    "stale_active_turn",
    "resynchronized",
  ]);
});
