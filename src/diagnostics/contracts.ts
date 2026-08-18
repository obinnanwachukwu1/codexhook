import type { DeliveryTruth, TransportId } from "../types.js";
export type { DeliveryTruth } from "../types.js";

export const DIAGNOSTIC_STAGES = [
  "protocol",
  "attachment",
  "state_synchronization",
  "submission",
  "canonical_verification",
  "fallback",
  "circuit_breaker",
] as const;

export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];

export const DIAGNOSTIC_OUTCOMES = [
  "started",
  "succeeded",
  "failed",
  "ambiguous",
  "unavailable",
  "rejected",
  "deferred",
  "recovered",
] as const;

export type DiagnosticOutcome = (typeof DIAGNOSTIC_OUTCOMES)[number];

export const DELIVERY_TRUTHS = [
  "confirmed_desktop",
  "confirmed_app_server",
  "ambiguous",
  "unavailable",
  "rejected",
] as const;

export const DIAGNOSTIC_CODES = [
  "protocol.attempt_started",
  "protocol.incompatible",
  "protocol.malformed_response",
  "protocol.unavailable",
  "attachment.attempt_started",
  "attachment.desktop_unavailable",
  "attachment.desktop_connected",
  "state.resume_failed",
  "state.await_failed",
  "state.revision_gap",
  "state.resynchronized",
  "state.reordered_patch",
  "state.stale_active_turn",
  "submission.started",
  "submission.confirmed",
  "submission.ambiguous",
  "submission.rejected",
  "submission.unavailable",
  "canonical.found",
  "canonical.absent",
  "canonical.unknown",
  "fallback.attempted",
  "fallback.selected",
  "fallback.exhausted",
  "circuit.opened",
  "circuit.half_open",
  "circuit.recovered",
  "other",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface DiagnosticEvent {
  readonly stage: DiagnosticStage;
  readonly outcome: DiagnosticOutcome;
  readonly code: DiagnosticCode;
  readonly transport?: TransportId;
  readonly deliveryTruth?: DeliveryTruth;
}

export interface DiagnosticRecord extends DiagnosticEvent {
  readonly schemaVersion: 1;
  readonly timestamp: string;
}

export interface DiagnosticObserver {
  readonly record: (event: DiagnosticEvent) => void;
}

export interface DiagnosticFailureSummary {
  readonly stage: DiagnosticStage;
  readonly code: DiagnosticCode;
  readonly outcome: DiagnosticOutcome;
  readonly count: number;
  readonly lastSeenAt: string;
  readonly deliveryTruth?: DeliveryTruth;
}

export function isDiagnosticStage(value: unknown): value is DiagnosticStage {
  return DIAGNOSTIC_STAGES.includes(value as DiagnosticStage);
}

export function isDiagnosticOutcome(value: unknown): value is DiagnosticOutcome {
  return DIAGNOSTIC_OUTCOMES.includes(value as DiagnosticOutcome);
}

export function isDeliveryTruth(value: unknown): value is DeliveryTruth {
  return DELIVERY_TRUTHS.includes(
    value as (typeof DELIVERY_TRUTHS)[number],
  );
}

export function diagnosticCode(value: unknown): DiagnosticCode {
  return DIAGNOSTIC_CODES.includes(value as DiagnosticCode)
    ? value as DiagnosticCode
    : "other";
}
