import { isDeliveryStage, type DeliveryStage } from "./stages.js";
import type { DeliveryRoute } from "./submission.js";

export const DIAGNOSTIC_CODES = [
  "desktop-unavailable",
  "desktop-incompatible",
  "desktop-not-following",
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

declare const sanitizedDiagnosticBrand: unique symbol;

export interface SanitizedDiagnostic {
  readonly [sanitizedDiagnosticBrand]: true;
  readonly code: DiagnosticCode;
  readonly stage?: DeliveryStage;
  readonly route?: DeliveryRoute;
  readonly protocolRevision?: number;
}

const CODES = new Set<string>(DIAGNOSTIC_CODES);

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function asDiagnosticCode(value: unknown): DiagnosticCode {
  return typeof value === "string" && CODES.has(value)
    ? value as DiagnosticCode
    : "internal";
}

function asRoute(value: unknown): DeliveryRoute | undefined {
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
  try {
    const source = asRecord(value);
    const code = source.code;
    const stage = source.stage;
    const route = source.route;
    const revision = source.protocolRevision;
    const safeCode = asDiagnosticCode(code);
    const safeStage = isDeliveryStage(stage)
      ? stage
      : undefined;
    const safeRoute = asRoute(route);
    const protocolRevision = nonNegativeInteger(revision);
    return Object.freeze({
      code: safeCode,
      ...(safeStage == null ? {} : { stage: safeStage }),
      ...(safeRoute == null ? {} : { route: safeRoute }),
      ...(protocolRevision == null ? {} : { protocolRevision }),
    }) as SanitizedDiagnostic;
  } catch {
    return Object.freeze({ code: "internal" }) as SanitizedDiagnostic;
  }
}
