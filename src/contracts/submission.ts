import type { DeliveryId, TurnId } from "../types.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";

export type DeliveryRoute = "desktop" | "app-server";
export type DeliveryOperation = "start" | "steer";
export type PreSubmissionFailureReason =
  | "unavailable"
  | "incompatible"
  | "pre-submit-failure";
export type SubmissionTruth =
  | "confirmed"
  | "not-submitted"
  | "unknown"
  | "rejected";

export type RouteSubmissionOutcome<
  Route extends DeliveryRoute = DeliveryRoute,
> =
  | {
      readonly _tag: "Confirmed";
      readonly route: Route;
      readonly deliveryId: DeliveryId;
      readonly turnId: TurnId;
      readonly operation: DeliveryOperation;
    }
  | {
      readonly _tag: "NotSubmitted";
      readonly route: Route;
      readonly deliveryId: DeliveryId;
      readonly reason: PreSubmissionFailureReason;
      readonly diagnostic: SanitizedDiagnostic;
    }
  | {
      readonly _tag: "Ambiguous";
      readonly route: Route;
      readonly deliveryId: DeliveryId;
      readonly diagnostic: SanitizedDiagnostic;
    }
  | {
      readonly _tag: "Rejected";
      readonly route: Route;
      readonly deliveryId: DeliveryId;
      readonly diagnostic: SanitizedDiagnostic;
    };

export function submissionTruth(
  outcome: RouteSubmissionOutcome,
): SubmissionTruth {
  switch (outcome._tag) {
    case "Confirmed":
      return "confirmed";
    case "NotSubmitted":
      return "not-submitted";
    case "Ambiguous":
      return "unknown";
    case "Rejected":
      return "rejected";
  }
}
