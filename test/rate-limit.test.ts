import assert from "node:assert/strict";
import test from "node:test";
import { ThreadRateLimiter } from "../src/rate-limit.js";

test("forgets inactive threads during normal rate-limit checks", () => {
  const limiter = new ThreadRateLimiter(10, 1_000);
  limiter.allow("old-thread", 0);
  limiter.allow("active-thread", 500);
  limiter.allow("new-thread", 1_001);

  const events = (
    limiter as unknown as { events: Map<string, number[]> }
  ).events;
  assert.equal(events.has("old-thread"), false);
  assert.equal(events.has("active-thread"), true);
  assert.equal(events.has("new-thread"), true);
});
