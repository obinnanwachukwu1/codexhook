import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Exit, Option } from "effect";
import {
  DesktopVisibilityUnconfirmed,
  DISPOSITIONS,
  SubmitAmbiguous,
} from "../src/transport/errors.js";
import {
  daemon,
  desktop,
  fakeProvider,
  runTransport,
  runTransportExit,
} from "./support/transport-fixture.js";

test("falls back only when turn bytes were provably not written", async () => {
  const fixture = fakeProvider({
    "app-bundled": "before-write",
    cli: "ok",
  });
  const { recorder } = fixture;
  const outcome = await runTransport(fixture);
  assert.deepEqual(recorder.opens, ["app-bundled", "cli"]);
  assert.deepEqual(recorder.writes, [
    { transport: "cli", method: "turn/start" },
  ]);
  assert.equal((outcome as { transport: string }).transport, "cli");
  assert.equal(recorder.maxLive, 1);
  assert.equal(JSON.stringify(recorder.logs).includes("hello"), false);
});

test("does not fall back after an ambiguous write", async () => {
  const fixture = fakeProvider({
    "app-bundled": "ambiguous",
    cli: "ok",
  });
  const { recorder } = fixture;
  const exit = await runTransportExit(fixture);
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(Option.isSome(failure), true);
    if (Option.isSome(failure)) {
      assert.equal(failure.value instanceof SubmitAmbiguous, true);
    }
  }
  assert.deepEqual(recorder.opens, ["app-bundled"]);
  assert.deepEqual(recorder.writes, [
    { transport: "app-bundled", method: "turn/start" },
  ]);
  assert.equal(recorder.maxLive, 1);
});

test("reconciles a daemon fallback through Desktop", async () => {
  const fixture = fakeProvider(
    {
      desktop: "follow-fail-then-visible",
      daemon: "ok",
    },
    [desktop, daemon],
  );
  const { recorder } = fixture;
  const outcome = await runTransport(fixture);
  assert.deepEqual(recorder.opens, ["desktop", "daemon", "desktop"]);
  assert.deepEqual(recorder.writes, [
    { transport: "daemon", method: "turn/start" },
  ]);
  assert.equal((outcome as { transport: string }).transport, "daemon");
  assert.equal(recorder.maxLive, 1);
  assert.equal(
    recorder.logs.some(
      (entry) =>
        entry.event === "transport_attempt_failed" &&
        entry.transport === "desktop" &&
        entry.stage === "follow" &&
        entry.errorTag === "TransportUnavailable",
    ),
    true,
  );
  assert.equal(
    recorder.logs.some(
      (entry) =>
        entry.event === "desktop_visibility_confirmed" &&
        entry.turnId === "turn-1",
    ),
    true,
  );
});

test("fails after fallback when Desktop cannot expose the completed turn", async () => {
  const fixture = fakeProvider(
    { desktop: "follow-fail", daemon: "ok" },
    [desktop, daemon],
  );
  const exit = await runTransportExit(fixture);
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(
      Option.isSome(failure) &&
        failure.value instanceof DesktopVisibilityUnconfirmed,
      true,
    );
  }
  assert.deepEqual(fixture.recorder.opens, [
    "desktop",
    "daemon",
    "desktop",
  ]);
  assert.equal(
    fixture.recorder.logs.some(
      (entry) =>
        entry.event === "desktop_visibility_failed" &&
        entry.submittedTransport === "daemon",
    ),
    true,
  );
});

test("a stale Desktop candidate falls back when the app closes", async () => {
  const fixture = fakeProvider(
    { desktop: "connect-fail", daemon: "ok" },
    [desktop, daemon],
  );
  const { recorder } = fixture;
  const outcome = await runTransport(fixture);
  assert.deepEqual(recorder.opens, ["daemon"]);
  assert.equal((outcome as { transport: string }).transport, "daemon");
});

test("never falls back when Desktop submission is ambiguous", async () => {
  const fixture = fakeProvider(
    { desktop: "ambiguous", daemon: "ok" },
    [desktop, daemon],
  );
  const { recorder } = fixture;
  const exit = await runTransportExit(fixture);
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(
      Option.isSome(failure) && failure.value instanceof SubmitAmbiguous,
      true,
    );
  }
  assert.deepEqual(recorder.opens, ["desktop"]);
  assert.deepEqual(recorder.writes, [
    { transport: "desktop", method: "turn/start" },
  ]);
});

test("queue waits for an active Desktop turn before starting", async () => {
  const fixture = fakeProvider(
    { desktop: "active-ok" },
    [desktop, daemon],
  );
  const { recorder } = fixture;
  const outcome = await runTransport(fixture, "queue");
  assert.deepEqual(recorder.writes, [
    { transport: "desktop", method: "await/turn-active" },
    { transport: "desktop", method: "turn/start" },
  ]);
  assert.equal((outcome as { transport: string }).transport, "desktop");
});

test("steer targets the active Desktop turn without waiting", async () => {
  const fixture = fakeProvider(
    { desktop: "active-ok" },
    [desktop, daemon],
  );
  const { recorder } = fixture;
  const outcome = await runTransport(fixture, "steer");
  assert.deepEqual(recorder.writes, [
    { transport: "desktop", method: "turn/steer" },
  ]);
  assert.equal((outcome as { _tag: string })._tag, "Steered");
});

test("classifies every transport error and forbids ambiguous retry", () => {
  assert.equal(DISPOSITIONS.TransportUnavailable.recovery, "try-next");
  assert.equal(DISPOSITIONS.TransportIncompatible.recovery, "try-next");
  assert.deepEqual(DISPOSITIONS.SubmitAmbiguous, {
    recovery: "stop",
    submission: "unknown",
  });
  assert.deepEqual(DISPOSITIONS.TurnAbandoned, {
    recovery: "stop",
    submission: "unknown",
  });
  assert.deepEqual(DISPOSITIONS.DesktopVisibilityUnconfirmed, {
    recovery: "stop",
    submission: "submitted",
  });
});
