import assert from "node:assert/strict";
import test from "node:test";
import { desktopOutcomeDetail } from "../src/transport/desktop-injection.js";

test("Desktop outcome detail exposes state proof without turn contents", () => {
  const detail = desktopOutcomeDetail({
    _tag: "Ambiguous",
    reason: "Desktop state proof timed out",
    state: {
      connection: "connected",
      attachment: "synchronized",
      activity: "active",
      injection: "uncertain",
      generation: 2,
      revision: 8,
      turns: [{
        id: "private-turn-id",
        status: "failed",
        error: { message: "private-turn-error" },
      }],
    },
  });

  assert.match(detail, /connection=connected/);
  assert.match(detail, /injection=uncertain/);
  assert.match(detail, /revision=8, generation=2/);
  assert.doesNotMatch(detail, /private-turn/);
});
