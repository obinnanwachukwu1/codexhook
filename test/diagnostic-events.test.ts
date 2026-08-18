import assert from "node:assert/strict";
import test from "node:test";
import { Option } from "effect";
import {
  attemptFailedEvent,
  canonicalFoundEvent,
  canonicalUnknownEvent,
  deliveryFailedEvent,
  deliverySucceededEvent,
  desktopStateEvent,
} from "../src/diagnostics/events.js";
import {
  deliveryTruth,
  DesktopVisibilityUnconfirmed,
  SubmitAmbiguous,
  SubmitRejected,
  TransportIncompatible,
  TransportUnavailable,
  TurnFailed,
  TurnTimeout,
} from "../src/transport/errors.js";
import { truthForTransport } from "../src/transport/truth.js";
import {
  DeliveryId,
  ThreadId,
  type TransportId,
  TurnId,
} from "../src/types.js";

test("terminal delivery truth distinguishes confirmation from uncertainty", () => {
  const threadId = ThreadId("thread-1");
  const turnId = TurnId("turn-1");
  assert.equal(deliveryTruth(new SubmitAmbiguous({
    transport: "desktop",
    method: "turn/start",
    threadId,
    deliveryId: DeliveryId("delivery-1"),
    cause: "disconnected",
  })), "ambiguous");
  assert.equal(deliveryTruth(new SubmitRejected({
    transport: "daemon",
    method: "turn/start",
    code: -1,
    message: "rejected",
  })), "rejected");
  assert.equal(deliveryTruth(new TurnFailed({
    transport: "desktop",
    threadId,
    turnId,
    status: "failed",
    message: Option.none(),
  })), "confirmed_desktop");
  assert.equal(deliveryTruth(new TurnTimeout({
    transport: "cli",
    threadId,
    turnId,
    waitedMillis: 100,
  })), "confirmed_app_server");
  assert.equal(deliveryTruth(new DesktopVisibilityUnconfirmed({
    threadId,
    turnId,
    submittedTransport: "daemon",
    reason: "refresh-failed",
    detail: "not visible",
  })), "confirmed_app_server");
});

test("failed and timed-out turns retain confirmation while naming their terminal stage", () => {
  const threadId = ThreadId("thread-1");
  const turnId = TurnId("turn-1");
  assert.deepEqual(deliveryFailedEvent(new TurnFailed({
    transport: "desktop",
    threadId,
    turnId,
    status: "failed",
    message: Option.none(),
  })), {
    stage: "canonical_verification",
    outcome: "failed",
    code: "canonical.turn_failed",
    deliveryTruth: "confirmed_desktop",
    transport: "desktop",
  });
  assert.deepEqual(deliveryFailedEvent(new TurnTimeout({
    transport: "cli",
    threadId,
    turnId,
    waitedMillis: 100,
  })), {
    stage: "canonical_verification",
    outcome: "failed",
    code: "canonical.turn_timeout",
    deliveryTruth: "confirmed_app_server",
    transport: "cli",
  });
});

test("successful delivery diagnostics preserve the submitting plane", () => {
  const threadId = ThreadId("thread-1");
  const turnId = TurnId("turn-1");
  assert.deepEqual(deliverySucceededEvent({
    _tag: "Completed",
    threadId,
    turnId,
    transport: "desktop",
  }), {
    stage: "submission",
    outcome: "succeeded",
    code: "submission.confirmed",
    deliveryTruth: "confirmed_desktop",
    transport: "desktop",
  });
  assert.deepEqual(deliverySucceededEvent({
    _tag: "Steered",
    threadId,
    turnId,
    transport: "daemon",
  }), {
    stage: "submission",
    outcome: "succeeded",
    code: "submission.confirmed",
    deliveryTruth: "confirmed_app_server",
    transport: "daemon",
  });
});

test("canonical item and Desktop state fixtures map to explicit journal states", () => {
  const absent = deliveryFailedEvent(new DesktopVisibilityUnconfirmed({
    threadId: ThreadId("thread-1"),
    turnId: TurnId("turn-1"),
    submittedTransport: "daemon",
    reason: "turn-not-exposed",
    detail: "turn not exposed",
  }));
  assert.deepEqual(
    [canonicalFoundEvent(), absent, canonicalUnknownEvent("deferred")]
      .map((event) => ({ code: event.code, outcome: event.outcome })),
    [
      { code: "canonical.found", outcome: "succeeded" },
      { code: "canonical.absent", outcome: "failed" },
      { code: "canonical.unknown", outcome: "deferred" },
    ],
  );
  const stateEvents: ReadonlyArray<Parameters<typeof desktopStateEvent>[0]> = [
    "revision_gap",
    "resynchronized",
    "reordered_patch",
    "stale_active_turn",
  ];
  assert.deepEqual(
    stateEvents.map(desktopStateEvent)
      .map((event) => ({ code: event.code, outcome: event.outcome })),
    [
      { code: "state.revision_gap", outcome: "failed" },
      { code: "state.resynchronized", outcome: "recovered" },
      { code: "state.reordered_patch", outcome: "deferred" },
      { code: "state.stale_active_turn", outcome: "deferred" },
    ],
  );
});

test("transport truth collapses only Desktop into the Desktop plane", () => {
  const transports: ReadonlyArray<TransportId> = [
    "desktop",
    "daemon",
    "app-bundled",
    "cli",
  ];
  assert.deepEqual(
    transports.map(truthForTransport),
    [
      "confirmed_desktop",
      "confirmed_app_server",
      "confirmed_app_server",
      "confirmed_app_server",
    ],
  );
});

test("attempt failures classify attachment, resume, and malformed protocol stages", () => {
  const desktop = attemptFailedEvent("desktop", "resume", new TransportUnavailable({
    transport: "desktop",
    reason: "connect-failed",
    detail: "unavailable",
  }));
  const resume = attemptFailedEvent("daemon", "resume", new TransportUnavailable({
    transport: "daemon",
    reason: "exited",
    detail: "unavailable",
  }));
  const malformed = attemptFailedEvent(
    "app-bundled",
    "connect",
    new TransportIncompatible({
      transport: "app-bundled",
      stage: "malformed",
      detail: "invalid response",
    }),
  );
  assert.deepEqual(desktop, {
    stage: "attachment",
    outcome: "unavailable",
    code: "attachment.desktop_unavailable",
    transport: "desktop",
  });
  assert.deepEqual(resume, {
    stage: "state_synchronization",
    outcome: "failed",
    code: "state.resume_failed",
    transport: "daemon",
  });
  assert.deepEqual(malformed, {
    stage: "protocol",
    outcome: "unavailable",
    code: "protocol.malformed_response",
    transport: "app-bundled",
  });
});
