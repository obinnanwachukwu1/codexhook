import assert from "node:assert/strict";
import test from "node:test";
import type { DiagnosticEvent } from "../src/diagnostics/contracts.js";
import {
  daemon,
  desktop,
  fakeProvider,
  runDelivery,
  type WriteBehavior,
} from "./support/transport-fixture.js";

interface ExpectedTerminal {
  readonly code: DiagnosticEvent["code"];
  readonly stage: DiagnosticEvent["stage"];
  readonly truth: NonNullable<DiagnosticEvent["deliveryTruth"]>;
}

test("composed delivery records each terminal failure exactly once", async () => {
  const cases: ReadonlyArray<{
    readonly behavior: WriteBehavior;
    readonly expected: ExpectedTerminal;
  }> = [
    {
      behavior: "turn-timeout",
      expected: {
        stage: "canonical_verification",
        code: "canonical.turn_timeout",
        truth: "confirmed_app_server",
      },
    },
    {
      behavior: "busy",
      expected: {
        stage: "state_synchronization",
        code: "state.await_failed",
        truth: "unavailable",
      },
    },
    {
      behavior: "turn-abandoned",
      expected: {
        stage: "submission",
        code: "submission.ambiguous",
        truth: "ambiguous",
      },
    },
    {
      behavior: "ambiguous",
      expected: {
        stage: "submission",
        code: "submission.ambiguous",
        truth: "ambiguous",
      },
    },
  ];

  for (const entry of cases) {
    const fixture = fakeProvider({ "app-bundled": entry.behavior });
    await runDelivery(fixture);
    assert.deepEqual(terminalEvents(fixture.recorder.diagnostics), [{
      stage: entry.expected.stage,
      code: entry.expected.code,
      truth: entry.expected.truth,
    }]);
  }
});

test("a reachable Desktop that lacks the fallback turn is canonically absent", async () => {
  const fixture = fakeProvider(
    { desktop: "follow-fail-then-absent", daemon: "ok" },
    [desktop, daemon],
  );
  await runDelivery(fixture);
  assert.deepEqual(terminalEvents(fixture.recorder.diagnostics), [{
    stage: "canonical_verification",
    code: "canonical.absent",
    truth: "confirmed_app_server",
  }]);
  assert.deepEqual(fixture.recorder.writes, [
    { transport: "daemon", method: "turn/start" },
  ]);
});

test("a reachable Desktop with an inconclusive refresh is canonically unknown", async () => {
  const fixture = fakeProvider(
    { desktop: "follow-fail", daemon: "ok" },
    [desktop, daemon],
  );
  await runDelivery(fixture);
  assert.deepEqual(terminalEvents(fixture.recorder.diagnostics), [{
    stage: "canonical_verification",
    code: "canonical.unknown",
    truth: "confirmed_app_server",
  }]);
  assert.deepEqual(fixture.recorder.writes, [
    { transport: "daemon", method: "turn/start" },
  ]);
});

test("a present but unconfirmed Desktop turn is canonically unknown", async () => {
  const fixture = fakeProvider(
    { desktop: "follow-fail-then-unconfirmed", daemon: "ok" },
    [desktop, daemon],
  );
  await runDelivery(fixture);
  assert.deepEqual(terminalEvents(fixture.recorder.diagnostics), [{
    stage: "canonical_verification",
    code: "canonical.unknown",
    truth: "confirmed_app_server",
  }]);
  assert.deepEqual(fixture.recorder.writes, [
    { transport: "daemon", method: "turn/start" },
  ]);
});

test("a rejected submission has one rejected log and journal truth", async () => {
  const fixture = fakeProvider({ "app-bundled": "rejected" });
  await runDelivery(fixture);
  assert.deepEqual(terminalEvents(fixture.recorder.diagnostics), [{
    stage: "submission",
    code: "submission.rejected",
    truth: "rejected",
  }]);
  const failure = fixture.recorder.logs.find((entry) =>
    entry.event === "delivery_failed"
  );
  assert.equal(failure?.submission, "rejected");
  assert.equal(failure?.deliveryTruth, "rejected");
  assert.equal(
    fixture.recorder.diagnostics.some((event) => event.stage === "fallback"),
    false,
  );
});

function terminalEvents(events: ReadonlyArray<DiagnosticEvent>) {
  return events
    .filter((event) => event.deliveryTruth != null)
    .map((event) => ({
      stage: event.stage,
      code: event.code,
      truth: event.deliveryTruth,
    }));
}
