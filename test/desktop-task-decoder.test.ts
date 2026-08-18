import assert from "node:assert/strict";
import test from "node:test";
import { acceptedTurnId } from "../src/transport/desktop-task-decoder.js";

test("accepted start identity uses only canonical response fields", () => {
  assert.equal(acceptedTurnId({ turnId: "turn-direct" }), "turn-direct");
  assert.equal(acceptedTurnId({ turn: { id: "turn-record" } }), "turn-record");
  assert.equal(
    acceptedTurnId({ submission: { turnId: "turn-submission" } }),
    "turn-submission",
  );
  assert.equal(acceptedTurnId({
    thread: { turns: [{ turnId: "historical-turn" }] },
  }), null);
});
