import assert from "node:assert/strict";
import test from "node:test";
import { DesktopThreadState } from "../src/transport/desktop-state.js";

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
