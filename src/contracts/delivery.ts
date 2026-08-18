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
  PreSubmissionFailureReason,
  RouteSubmissionOutcome,
  SubmissionTruth,
} from "./submission.js";

export interface DeliveryRequest {
  readonly task: LocalTaskRef;
  readonly deliveryId: DeliveryId;
  readonly message: string;
  readonly mode: DeliveryMode;
  readonly idleTimeout: Duration.DurationInput;
  readonly turnTimeout: Duration.DurationInput;
}

export interface DeliveryAttempt {
  readonly route: DeliveryRoute;
  readonly stage: DeliveryStage;
  readonly submission: SubmissionTruth;
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

export interface DeliveryPolicy {
  readonly taskScope: "local-only";
  readonly preferredRoute: "desktop";
  readonly fallbackRoute: "app-server";
  readonly fallbackAfter: ReadonlyArray<PreSubmissionFailureReason>;
  readonly ambiguousSubmission: "stop-and-reconcile";
  readonly reconciliation: "app-server-observe-only";
  readonly retry: "none";
}

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
}) satisfies DeliveryPolicy;

export function mayFallback(
  outcome: RouteSubmissionOutcome,
): boolean {
  return outcome.route === PHASE_ONE_DELIVERY_POLICY.preferredRoute &&
    outcome._tag === "NotSubmitted" &&
    // This explicit allowlist remains fail-closed if new reasons are added.
    PHASE_ONE_DELIVERY_POLICY.fallbackAfter.includes(outcome.reason);
}

export interface DeliveryCoordinator {
  readonly policy: DeliveryPolicy;
  /**
   * Owns any Desktop scope for one delivery and returns a classified outcome;
   * no non-fatal adapter failure or defect may escape the effect.
   */
  readonly deliver: (
    request: DeliveryRequest,
  ) => Effect.Effect<DeliveryOutcome>;
}

export class LocalDeliveryCoordinator extends Context.Tag(
  "codexhook/LocalDeliveryCoordinator",
)<LocalDeliveryCoordinator, DeliveryCoordinator>() {}
