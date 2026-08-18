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
} from "./submission.js";

export type { DeliveryStage } from "./stages.js";
export { DELIVERY_STAGES } from "./stages.js";
export type {
  DeliveryOperation,
  DeliveryRoute,
  PreSubmissionFailureReason,
  RouteSubmissionOutcome,
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
  readonly submission: "confirmed" | "not-submitted" | "unknown" | "rejected";
  readonly elapsedMs: number;
  readonly diagnostic?: SanitizedDiagnostic;
}

interface ConfirmedDelivery {
  readonly task: LocalTaskRef;
  readonly deliveryId: DeliveryId;
  readonly turnId: TurnId;
  readonly operation: DeliveryOperation;
  readonly submission: "confirmed";
  readonly attempts: ReadonlyArray<DeliveryAttempt>;
}

export type DeliveryOutcome =
  | (ConfirmedDelivery & {
      readonly _tag: "ConfirmedDesktop";
      readonly confirmedBy: "desktop";
    })
  | (ConfirmedDelivery & {
      readonly _tag: "ConfirmedAppServer";
      readonly confirmedBy: "app-server";
    })
  | {
      readonly _tag: "Ambiguous";
      readonly task: LocalTaskRef;
      readonly deliveryId: DeliveryId;
      readonly route: DeliveryRoute;
      readonly submission: "unknown";
      readonly attempts: ReadonlyArray<DeliveryAttempt>;
      readonly diagnostic: SanitizedDiagnostic;
    }
  | {
      readonly _tag: "Unavailable";
      readonly task: LocalTaskRef;
      readonly deliveryId: DeliveryId;
      readonly submission: "not-submitted";
      readonly attempts: ReadonlyArray<DeliveryAttempt>;
      readonly diagnostic: SanitizedDiagnostic;
    }
  | {
      readonly _tag: "Rejected";
      readonly task: LocalTaskRef;
      readonly deliveryId: DeliveryId;
      readonly route: DeliveryRoute;
      readonly submission: "rejected";
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

export type FallbackReason = PreSubmissionFailureReason;

export function mayFallback(
  outcome: RouteSubmissionOutcome,
  policy: DeliveryPolicy = PHASE_ONE_DELIVERY_POLICY,
): boolean {
  return outcome.route === policy.preferredRoute &&
    outcome._tag === "NotSubmitted" &&
    policy.fallbackAfter.includes(outcome.reason);
}

export interface DeliveryCoordinator {
  readonly policy: DeliveryPolicy;
  readonly deliver: (
    request: DeliveryRequest,
  ) => Effect.Effect<DeliveryOutcome>;
}

export class LocalDeliveryCoordinator extends Context.Tag(
  "codexhook/LocalDeliveryCoordinator",
)<LocalDeliveryCoordinator, DeliveryCoordinator>() {}
