import type { Duration, Effect, Scope } from "effect";
import type {
  DeliveryId,
  TurnId,
} from "../types.js";
import type {
  CompatibleProtocol,
  ProtocolAvailability,
} from "./compatibility.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";
import type { LocalTaskRef } from "./local-codex.js";
import type { RouteSubmissionOutcome } from "./submission.js";

export type DesktopAvailability = ProtocolAvailability;

export interface DesktopFailure {
  readonly _tag: "DesktopFailure";
  readonly diagnostic: SanitizedDiagnostic;
}

interface DesktopSubmission {
  readonly task: LocalTaskRef;
  readonly deliveryId: DeliveryId;
  readonly message: string;
  /** Bounds the post-submit reply wait inside the possible-write region. */
  readonly replyTimeout: Duration.Duration;
}

/** A steer is fenced to the active turn observed by `follow`. */
export type DesktopSubmissionRequest = DesktopSubmission & (
  | { readonly mode: "queue" }
  | { readonly mode: "steer"; readonly expectedTurnId: TurnId }
);

export interface DesktopTaskObservation {
  readonly task: LocalTaskRef;
  readonly activeTurnId: TurnId | null;
}

/**
 * A scoped, initialized Desktop IPC connection owned by one delivery. The
 * coordinator does not share a session across concurrent deliveries.
 */
export interface DesktopSession {
  readonly compatibility: CompatibleProtocol;
  readonly follow: (
    task: LocalTaskRef,
  ) => Effect.Effect<DesktopTaskObservation, DesktopFailure>;
  /**
   * The possible-write region is uninterruptible. Convert every non-fatal
   * failure or defect into an outcome; any uncertain write becomes Ambiguous.
   */
  readonly submit: (
    request: DesktopSubmissionRequest,
  ) => Effect.Effect<RouteSubmissionOutcome<"desktop">>;
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
