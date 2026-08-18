import assert from "node:assert/strict";
import test from "node:test";
import {
  checkProtocolCompatibility,
  diagnosticSummary,
  mayFallback,
  PHASE_ONE_DELIVERY_POLICY,
  sanitizeDiagnostic,
  type LocalTaskRef,
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

const compatibleOffer: ProtocolOffer = {
  plane: "desktop-ipc",
  major: 1,
  revision: 3,
  features: ["task-follow", "turn-start", "delivery-id", "turn-steer"],
};

test("protocol compatibility accepts a complete offer", () => {
  assert.deepEqual(checkProtocolCompatibility(requirement, compatibleOffer), {
    status: "compatible",
    plane: "desktop-ipc",
    major: 1,
    revision: 3,
    features: compatibleOffer.features,
  });
});

test("protocol compatibility reports each incompatible condition", () => {
  const cases: ReadonlyArray<{
    readonly offer: ProtocolOffer;
    readonly reason: string;
    readonly missingFeatures?: ReadonlyArray<string>;
  }> = [
    {
      offer: { ...compatibleOffer, plane: "app-server" },
      reason: "wrong-plane",
    },
    {
      offer: { ...compatibleOffer, major: 2 },
      reason: "major-mismatch",
    },
    {
      offer: { ...compatibleOffer, revision: 1 },
      reason: "revision-too-old",
    },
    {
      offer: {
        ...compatibleOffer,
        features: ["task-follow", "turn-start"],
      },
      reason: "missing-feature",
      missingFeatures: ["delivery-id"],
    },
  ];

  for (const item of cases) {
    const result = checkProtocolCompatibility(requirement, item.offer);
    assert.equal(result.status, "incompatible");
    if (result.status === "incompatible") {
      assert.equal(result.reason, item.reason);
      if (result.reason === "missing-feature") {
        assert.deepEqual(result.missingFeatures, item.missingFeatures);
      } else {
        assert.equal(item.missingFeatures, undefined);
      }
    }
  }
});

test("only the canonical service can mint a local task reference", () => {
  const untrusted = {
    threadId: ThreadId("thread-1"),
    provenance: { scope: "local", origin: "cli" },
  } as const;
  // @ts-expect-error LocalTaskRef carries a private canonical-service brand.
  const local: LocalTaskRef = untrusted;
  assert.equal(local.threadId, "thread-1");
});

test("fallback requires a confirmed Desktop non-submission", () => {
  const deliveryId = DeliveryId("delivery-1");
  const diagnostic = sanitizeDiagnostic({ code: "desktop-unavailable" });
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
  const rejected: RouteSubmissionOutcome = {
    _tag: "Rejected",
    route: "desktop",
    deliveryId,
    diagnostic: sanitizeDiagnostic({ code: "request-rejected" }),
  };
  const appServerFailure: RouteSubmissionOutcome = {
    ...notSubmitted,
    route: "app-server",
  };

  assert.equal(mayFallback(notSubmitted), true);
  assert.equal(mayFallback(ambiguous), false);
  assert.equal(mayFallback(confirmed), false);
  assert.equal(mayFallback(rejected), false);
  assert.equal(mayFallback(appServerFailure), false);
  assert.equal(PHASE_ONE_DELIVERY_POLICY.retry, "none");
  assert.equal(
    PHASE_ONE_DELIVERY_POLICY.reconciliation,
    "app-server-observe-only",
  );
});

test("sanitized diagnostics retain only allowlisted structured fields", () => {
  const diagnostic = sanitizeDiagnostic({
    code: "write-ambiguous",
    stage: "submit-desktop",
    route: "desktop",
    protocolRevision: 4,
    summary: "caller supplied",
    token: "secret-token",
    body: "untrusted webhook body",
    socketPath: "/private/socket",
    detail: "raw protocol error",
  });
  assert.deepEqual(diagnostic, {
    code: "write-ambiguous",
    stage: "submit-desktop",
    route: "desktop",
    protocolRevision: 4,
  });
  assert.equal(
    diagnosticSummary(diagnostic.code),
    "Submission may have been written",
  );
});

test("invalid diagnostics degrade to a fixed internal code", () => {
  assert.deepEqual(sanitizeDiagnostic({
    code: "not-allowlisted",
    stage: "not-a-stage",
    route: "remote",
    attempt: -1,
    protocolRevision: 1.5,
  }), { code: "internal" });
  assert.equal(
    diagnosticSummary("internal"),
    "An internal delivery error occurred",
  );
});

test("diagnostic sanitization is safe for production failure shapes", () => {
  const values = [
    new Error("connect ENOENT /private/desktop.sock"),
    "raw token string",
    null,
    undefined,
  ];
  for (const value of values) {
    const diagnostic = sanitizeDiagnostic(value);
    assert.deepEqual(diagnostic, { code: "internal" });
    assert.equal(Object.isFrozen(diagnostic), true);
  }
});

test("root exports retain legacy and contract services", async () => {
  const publicApi = await import("../src/index.js");
  assert.equal(typeof publicApi.Delivery, "function");
  assert.equal(typeof publicApi.CodexTransport, "function");
  assert.equal(typeof publicApi.LocalCodex, "function");
  assert.equal(typeof publicApi.LocalDeliveryCoordinator, "function");
  assert.equal(Array.isArray(publicApi.DELIVERY_STAGES), true);
});
