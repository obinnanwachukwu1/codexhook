import type { Effect, Scope } from "effect";
import type {
  DeliveryId,
  DeliveryMode,
  TurnId,
} from "../types.js";
import type {
  CompatibleProtocol,
  ProtocolAvailability,
} from "./compatibility.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";
import type { LocalTaskRef, LocalTurn } from "./local-codex.js";
import type { RouteSubmissionOutcome } from "./submission.js";

export type DesktopAvailability = ProtocolAvailability;

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
   * Convert every non-fatal failure or defect into an outcome. Any cause at or
   * after a possible write must become Ambiguous instead of escaping.
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
