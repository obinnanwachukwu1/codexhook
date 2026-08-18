import assert from "node:assert/strict";
import test from "node:test";
import { ServiceLifecycle } from "../src/service/lifecycle.js";

test("lifecycle drains admitted requests and rejects new work", async () => {
  const lifecycle = new ServiceLifecycle();
  lifecycle.ready();
  const release = lifecycle.enter();
  assert.notEqual(release, null);
  assert.equal(lifecycle.beginDrain(), true);
  assert.equal(lifecycle.beginDrain(), false);
  assert.equal(lifecycle.enter(), null);

  const waiting = lifecycle.waitForIdle(1_000);
  release?.();
  release?.();
  assert.equal(await waiting, true);
  assert.equal(lifecycle.snapshot().activeRequests, 0);
  lifecycle.stopped();
  assert.equal(lifecycle.snapshot().phase, "stopped");
});

test("lifecycle idle waits are bounded", async () => {
  const lifecycle = new ServiceLifecycle();
  lifecycle.ready();
  const release = lifecycle.enter();
  assert.equal(await lifecycle.waitForIdle(1), false);
  release?.();
});
