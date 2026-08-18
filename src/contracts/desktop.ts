import type { Effect, Scope } from "effect";
import type {
  DeliveryId,
  DeliveryMode,
  TurnId,
} from "../types.js";
import type {
  ProtocolCompatibility,
  ProtocolOffer,
} from "./compatibility.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";
import type { LocalTaskRef, LocalTurn } from "./local-codex.js";
import type { RouteSubmissionOutcome } from "./submission.js";

export type DesktopAvailability =
  | {
      readonly status: "available";
      readonly offer: ProtocolOffer;
      readonly compatibility: Extract<
        ProtocolCompatibility,
        { readonly status: "compatible" }
      >;
    }
  | {
      readonly status: "unavailable" | "incompatible";
      readonly diagnostic: SanitizedDiagnostic;
    };

export interface DesktopFailure {
  readonly _tag: "DesktopFailure";
  readonly diagnostic: SanitizedDiagnostic;
}

export interface DesktopSubmissionRequest {
  readonly task: LocalTaskRef;
  readonly deliveryId: DeliveryId;
  readonly mode: DeliveryMode;
  readonly message: string;
  readonly expectedTurnId?: TurnId;
}

export interface DesktopTaskObservation {
  readonly task: LocalTaskRef;
  readonly turns: ReadonlyArray<LocalTurn>;
  readonly revision: number;
}

export type DesktopSubmissionObservation =
  | {
      readonly status: "observed";
      readonly deliveryId: DeliveryId;
      readonly turnId: TurnId;
    }
  | {
      readonly status: "not-observed";
      readonly deliveryId: DeliveryId;
    };

/** A scoped, initialized Desktop IPC connection. */
export interface DesktopSession {
  readonly compatibility: Extract<
    ProtocolCompatibility,
    { readonly status: "compatible" }
  >;
  readonly follow: (
    task: LocalTaskRef,
  ) => Effect.Effect<DesktopTaskObservation, DesktopFailure>;
  readonly submit: (
    request: DesktopSubmissionRequest,
  ) => Effect.Effect<RouteSubmissionOutcome<"desktop">>;
  readonly observeSubmission: (
    task: LocalTaskRef,
    deliveryId: DeliveryId,
  ) => Effect.Effect<DesktopSubmissionObservation, DesktopFailure>;
}

/** Desktop transport boundary; it is never the task-list authority. */
export interface DesktopProtocol {
  readonly availability: Effect.Effect<DesktopAvailability>;
  readonly connect: Effect.Effect<
    DesktopSession,
    DesktopFailure,
    Scope.Scope
  >;
}
