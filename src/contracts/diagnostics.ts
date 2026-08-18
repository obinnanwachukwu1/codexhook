import { isDeliveryStage, type DeliveryStage } from "./stages.js";
import type { DeliveryRoute } from "./submission.js";

export const DIAGNOSTIC_CODES = [
  "desktop-unavailable",
  "desktop-incompatible",
  "app-server-unavailable",
  "app-server-incompatible",
  "task-not-local",
  "task-not-found",
  "write-ambiguous",
  "request-rejected",
  "timeout",
  "disconnected",
  "internal",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface SanitizedDiagnostic {
  readonly code: DiagnosticCode;
  readonly summary: string;
  readonly stage?: DeliveryStage;
  readonly route?: DeliveryRoute;
  readonly attempt?: number;
  readonly protocolRevision?: number;
}

const CODES = new Set<string>(DIAGNOSTIC_CODES);
const SUMMARIES = {
  "desktop-unavailable": "Desktop delivery is unavailable",
  "desktop-incompatible": "Desktop protocol is incompatible",
  "app-server-unavailable": "Local app-server is unavailable",
  "app-server-incompatible": "App-server protocol is incompatible",
  "task-not-local": "Task is outside the local Codex store",
  "task-not-found": "Task was not found in the local Codex store",
  "write-ambiguous": "Submission may have been written",
  "request-rejected": "Submission was explicitly rejected",
  timeout: "The delivery stage timed out",
  disconnected: "The local connection closed",
  internal: "An internal delivery error occurred",
} as const satisfies Record<DiagnosticCode, string>;

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function code(value: unknown): DiagnosticCode {
  return typeof value === "string" && CODES.has(value)
    ? value as DiagnosticCode
    : "internal";
}

function route(value: unknown): DeliveryRoute | undefined {
  return value === "desktop" || value === "app-server"
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ? value
    : undefined;
}

/**
 * Converts unknown failure data into an allowlisted diagnostic. Arbitrary
 * strings are deliberately discarded so bodies, tokens, paths, and protocol
 * error text cannot cross the public/logging contract by accident.
 */
export function sanitizeDiagnostic(value: unknown): SanitizedDiagnostic {
  const source = record(value);
  const safeCode = code(source.code);
  const safeStage = isDeliveryStage(source.stage)
    ? source.stage
    : undefined;
  const safeRoute = route(source.route);
  const attempt = nonNegativeInteger(source.attempt);
  const protocolRevision = nonNegativeInteger(source.protocolRevision);
  return Object.freeze({
    code: safeCode,
    summary: SUMMARIES[safeCode],
    ...(safeStage == null ? {} : { stage: safeStage }),
    ...(safeRoute == null ? {} : { route: safeRoute }),
    ...(attempt == null ? {} : { attempt }),
    ...(protocolRevision == null ? {} : { protocolRevision }),
  });
}
