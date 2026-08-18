import type { DeliveryId, TurnId } from "../types.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";

export type DeliveryRoute = "desktop" | "app-server";
export type DeliveryOperation = "start" | "steer";
export type NotSubmittedReason =
  | "unavailable"
  | "incompatible"
  | "pre-submit-failure"
  /** The route replied after transport write but proved no Codex task write. */
  | "confirmed-not-submitted";

/** @deprecated Use NotSubmittedReason; not every safe non-submission is pre-write. */
export type PreSubmissionFailureReason = NotSubmittedReason;

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
      readonly reason: NotSubmittedReason;
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
