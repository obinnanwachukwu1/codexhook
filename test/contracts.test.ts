import assert from "node:assert/strict";
import test from "node:test";
import {
  checkProtocolCompatibility,
  localTaskRef,
  mayFallback,
  PHASE_ONE_DELIVERY_POLICY,
  sanitizeDiagnostic,
  validateLocalTask,
  type ProtocolOffer,
  type ProtocolRequirement,
  type RouteSubmissionOutcome,
} from "../src/contracts/index.js";
import {
  DeliveryId,
  ThreadId,
  TurnId,
} from "../src/types.js";

const requirement: ProtocolRequirement = {
  plane: "desktop-ipc",
  major: 1,
  minimumRevision: 2,
  requiredFeatures: ["task-follow", "turn-start", "delivery-id"],
};

test("protocol compatibility requires the plane, major, revision, and features", () => {
  const offer: ProtocolOffer = {
    plane: "desktop-ipc",
    major: 1,
    revision: 3,
    features: ["task-follow", "turn-start", "delivery-id", "turn-steer"],
  };
  assert.deepEqual(checkProtocolCompatibility(requirement, offer), {
    status: "compatible",
    plane: "desktop-ipc",
    major: 1,
    revision: 3,
    features: offer.features,
  });

  assert.deepEqual(
    checkProtocolCompatibility(requirement, {
      ...offer,
      features: ["task-follow", "turn-start"],
    }),
    {
      status: "incompatible",
      plane: "desktop-ipc",
      reason: "missing-feature",
      missingFeatures: ["delivery-id"],
    },
  );
});

test("local task references are app-server discovered and reject remote provenance", () => {
  const local = localTaskRef(ThreadId("thread-1"), "cli");
  assert.deepEqual(validateLocalTask({ ...local, secret: "discarded" }), {
    ok: true,
    task: local,
  });
  assert.deepEqual(local.provenance, {
    scope: "local",
    store: "codex",
    hostId: "local",
    discoveredVia: "app-server",
    origin: "cli",
  });

  const remote = {
    ...local,
    provenance: { ...local.provenance, hostId: "remote-1" },
  };
  const validation = validateLocalTask(remote);
  assert.equal(validation.ok, false);
  if (!validation.ok) {
    assert.equal(validation.diagnostic.code, "task-not-local");
    assert.equal(validation.diagnostic.stage, "resolve-task");
  }
});

test("fallback is allowed only after a confirmed non-submission", () => {
  const deliveryId = DeliveryId("delivery-1");
  const diagnostic = sanitizeDiagnostic({
    code: "desktop-unavailable",
    stage: "connect-desktop",
    route: "desktop",
  });
  const notSubmitted: RouteSubmissionOutcome = {
    _tag: "NotSubmitted",
    route: "desktop",
    deliveryId,
    reason: "unavailable",
    diagnostic,
  };
  const ambiguous: RouteSubmissionOutcome = {
    _tag: "Ambiguous",
    route: "desktop",
    deliveryId,
    diagnostic: sanitizeDiagnostic({ code: "write-ambiguous" }),
  };
  const confirmed: RouteSubmissionOutcome = {
    _tag: "Confirmed",
    route: "desktop",
    deliveryId,
    turnId: TurnId("turn-1"),
    operation: "start",
  };

  assert.equal(mayFallback(notSubmitted), true);
  assert.equal(mayFallback(ambiguous), false);
  assert.equal(mayFallback(confirmed), false);
  assert.equal(PHASE_ONE_DELIVERY_POLICY.retry, "none");
  assert.equal(
    PHASE_ONE_DELIVERY_POLICY.reconciliation,
    "app-server-observe-only",
  );
});

test("sanitized diagnostics discard secrets, bodies, paths, and raw errors", () => {
  const diagnostic = sanitizeDiagnostic({
    code: "write-ambiguous",
    stage: "submit-desktop",
    route: "desktop",
    attempt: 1,
    protocolRevision: 4,
    token: "secret-token",
    body: "untrusted webhook body",
    socketPath: "/private/socket",
    detail: "raw protocol error",
  });
  assert.deepEqual(diagnostic, {
    code: "write-ambiguous",
    summary: "Submission may have been written",
    stage: "submit-desktop",
    route: "desktop",
    attempt: 1,
    protocolRevision: 4,
  });
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("untrusted webhook body"), false);
  assert.equal(serialized.includes("/private/socket"), false);
  assert.equal(serialized.includes("raw protocol error"), false);
});
