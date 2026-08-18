import { Context, type Duration, type Effect } from "effect";
import type {
  DeliveryId,
  DeliveryMode,
  TurnId,
} from "../types.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";
import type { LocalTaskRef } from "./local-codex.js";
import type { DeliveryStage } from "./stages.js";
import type {
  DeliveryOperation,
  DeliveryRoute,
  RouteSubmissionOutcome,
} from "./submission.js";

export interface DeliveryRequest {
  readonly task: LocalTaskRef;
  readonly deliveryId: DeliveryId;
  readonly message: string;
  readonly mode: DeliveryMode;
  /** Bounds each individual wait, including a reconciliation match. */
  readonly idleTimeout: Duration.Duration;
  /** Bounds the complete delivery, including any reconciliation. */
  readonly turnTimeout: Duration.Duration;
}

/**
 * Authoritative record for one route attempt. A nested diagnostic may repeat
 * its route and stage so that it remains meaningful when logged on its own.
 */
export interface DeliveryAttempt {
  readonly route: DeliveryRoute;
  readonly stage: DeliveryStage;
  readonly outcome: RouteSubmissionOutcome["_tag"];
  readonly elapsedMs: number;
  readonly diagnostic?: SanitizedDiagnostic;
}

interface ConfirmedDelivery {
  readonly task: LocalTaskRef;
  readonly deliveryId: DeliveryId;
  readonly turnId: TurnId;
  readonly operation: DeliveryOperation;
  readonly attempts: ReadonlyArray<DeliveryAttempt>;
}

/**
 * Confirmed tags identify the route that wrote, not the observing plane.
 * Ambiguous and Rejected repeat the implicated route; Unavailable omits it
 * because routes were exhausted. `attempts` remains the audit trail.
 */
export type DeliveryOutcome =
  | (ConfirmedDelivery & {
      readonly _tag: "ConfirmedDesktop";
    })
  | (ConfirmedDelivery & {
      readonly _tag: "ConfirmedAppServer";
    })
  | {
      readonly _tag: "Ambiguous";
      readonly task: LocalTaskRef;
      readonly deliveryId: DeliveryId;
      readonly route: DeliveryRoute;
      readonly attempts: ReadonlyArray<DeliveryAttempt>;
      readonly diagnostic: SanitizedDiagnostic;
    }
  | {
      readonly _tag: "Unavailable";
      readonly task: LocalTaskRef;
      readonly deliveryId: DeliveryId;
      readonly attempts: ReadonlyArray<DeliveryAttempt>;
      readonly diagnostic: SanitizedDiagnostic;
    }
  | {
      readonly _tag: "Rejected";
      readonly task: LocalTaskRef;
      readonly deliveryId: DeliveryId;
      readonly route: DeliveryRoute;
      readonly attempts: ReadonlyArray<DeliveryAttempt>;
      readonly diagnostic: SanitizedDiagnostic;
    };

export const PHASE_ONE_DELIVERY_POLICY = Object.freeze({
  taskScope: "local-only",
  preferredRoute: "desktop",
  fallbackRoute: "app-server",
  fallbackAfter: Object.freeze([
    "unavailable",
    "incompatible",
    "pre-submit-failure",
  ] as const),
  ambiguousSubmission: "stop-and-reconcile",
  reconciliation: "app-server-observe-only",
  retry: "none",
} as const);

export type DeliveryPolicy = typeof PHASE_ONE_DELIVERY_POLICY;

export function mayFallback(
  outcome: RouteSubmissionOutcome,
): boolean {
  return outcome.route === PHASE_ONE_DELIVERY_POLICY.preferredRoute &&
    outcome._tag === "NotSubmitted" &&
    // Type checking forces this allowlist to be revisited for new reasons.
    PHASE_ONE_DELIVERY_POLICY.fallbackAfter.includes(outcome.reason);
}

export interface DeliveryCoordinator {
  readonly policy: DeliveryPolicy;
  /**
   * Owns any Desktop scope for one delivery and returns a classified outcome;
   * no non-fatal adapter failure or defect may escape the effect. The possible
   * write region is uninterruptible until its outcome is classified. Every
   * wait is timeout-bounded; reconciliation expiry remains Ambiguous.
   */
  readonly deliver: (
    request: DeliveryRequest,
  ) => Effect.Effect<DeliveryOutcome>;
}

export class LocalDeliveryCoordinator extends Context.Tag(
  "codexhook/LocalDeliveryCoordinator",
)<LocalDeliveryCoordinator, DeliveryCoordinator>() {}
