import assert from "node:assert/strict";
import test from "node:test";
import {
  checkProtocolCompatibility,
  mayFallback,
  PHASE_ONE_DELIVERY_POLICY,
  sanitizeDiagnostic,
  type LocalTaskRef,
  type ProtocolOffer,
  type ProtocolRequirement,
  type RouteSubmissionOutcome,
  type SanitizedDiagnostic,
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
    },
  ];

  for (const item of cases) {
    const result = checkProtocolCompatibility(requirement, item.offer);
    assert.equal(result.status, "incompatible");
    if (result.status === "incompatible") {
      assert.equal(result.reason, item.reason);
    }
  }
});

test("only the canonical service can mint a local task reference", () => {
  const untrusted = {
    threadId: ThreadId("thread-1"),
    origin: "cli",
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
  const confirmedNotSubmitted: RouteSubmissionOutcome = {
    ...notSubmitted,
    reason: "confirmed-not-submitted",
  };
  const taskBusy: RouteSubmissionOutcome = {
    ...notSubmitted,
    reason: "task-busy",
  };

  assert.equal(mayFallback(notSubmitted), true);
  assert.equal(mayFallback(confirmedNotSubmitted), true);
  assert.equal(mayFallback(taskBusy), false);
  assert.equal(mayFallback(ambiguous), false);
  assert.equal(mayFallback(confirmed), false);
  assert.equal(mayFallback(rejected), false);
  assert.equal(mayFallback(appServerFailure), false);
  assert.equal(Object.isFrozen(PHASE_ONE_DELIVERY_POLICY), true);
  assert.equal(Object.isFrozen(PHASE_ONE_DELIVERY_POLICY.fallbackAfter), true);
  assert.equal(PHASE_ONE_DELIVERY_POLICY.preferredRoute, "desktop");
  assert.equal(PHASE_ONE_DELIVERY_POLICY.fallbackRoute, "app-server");
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
});

test("only the sanitizer can mint a sanitized diagnostic", () => {
  const leaky = {
    code: "internal",
    token: "secret-token",
  } as const;
  // @ts-expect-error SanitizedDiagnostic carries a private sanitizer brand.
  const diagnostic: SanitizedDiagnostic = leaky;
  assert.equal(diagnostic.code, "internal");
});

test("invalid diagnostics degrade to a fixed internal code", () => {
  assert.deepEqual(sanitizeDiagnostic({
    code: "not-allowlisted",
    stage: "not-a-stage",
    route: "remote",
    attempt: -1,
    protocolRevision: 1.5,
  }), { code: "internal" });
  assert.deepEqual(sanitizeDiagnostic({
    code: "not-allowlisted",
    stage: "submit-desktop",
    route: "desktop",
    protocolRevision: 3,
  }), {
    code: "internal",
    stage: "submit-desktop",
    route: "desktop",
    protocolRevision: 3,
  });
  assert.deepEqual(sanitizeDiagnostic({
    code: "timeout",
    stage: "not-a-stage",
  }), { code: "timeout" });
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

test("diagnostic sanitization contains hostile property access", () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error("untrusted getter");
    },
  });
  const diagnostic = sanitizeDiagnostic(hostile);
  assert.deepEqual(diagnostic, { code: "internal" });
  assert.equal(Object.isFrozen(diagnostic), true);
});

test("root exports expose canonical services without legacy routing", async () => {
  const publicApi = await import("../src/index.js");
  assert.equal(typeof publicApi.Delivery, "function");
  assert.equal("CodexTransport" in publicApi, false);
  assert.equal(typeof publicApi.LocalCodex, "function");
  assert.equal(typeof publicApi.LocalCodexLive, "object");
  assert.equal("CanonicalAppServerClient" in publicApi, false);
  assert.equal("CanonicalAppServer" in publicApi, false);
  assert.equal("APP_SERVER_COMPATIBILITY" in publicApi, false);
  assert.equal("DesktopProtocolSession" in publicApi, false);
  assert.equal("DesktopProtocolError" in publicApi, false);
  assert.equal(typeof publicApi.LocalDeliveryCoordinator, "function");
  assert.equal(Array.isArray(publicApi.DELIVERY_STAGES), true);
});
