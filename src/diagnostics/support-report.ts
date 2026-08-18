import type { DaemonProbe } from "../daemon-control.js";
import type { DiagnosticCode } from "../contracts/diagnostics.js";
import type { DeliveryStage } from "../contracts/stages.js";
import type { DeliveryRoute } from "../contracts/submission.js";
import {
  type DeliveryOutcomeTag,
  type DiagnosticJournalSnapshot,
  type DiagnosticRecord,
} from "./journal.js";

const FAILURE_LIMIT = 12;
const DISCLOSURE = [
  "No task, turn, delivery, hook, path, message, timestamp, or secret identifiers are included.",
  "Nothing is transmitted; this command only produces a local payload.",
] as const;

export interface CompatibilityReportInput {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly installation: {
    readonly manifest: boolean;
    readonly runtime: boolean;
    readonly skill: boolean;
    readonly service: boolean;
    readonly nodeCompatible: boolean;
  };
  readonly daemon: DaemonProbe;
  readonly offlineDesktopIpcAvailable: boolean;
  readonly offlineAppServerCandidateFound: boolean;
  readonly journal: DiagnosticJournalSnapshot;
}

export interface CompatibilityReportPayload {
  readonly schemaVersion: 1;
  readonly codexhookVersion: string;
  readonly runtime: {
    readonly platform: "darwin" | "linux" | "win32" | "other";
    readonly architecture: "arm64" | "x64" | "other";
    readonly nodeMajor: number | null;
  };
  readonly installation: CompatibilityReportInput["installation"];
  readonly daemon: {
    readonly state: "running" | "stopped" | "unreachable";
    readonly phase: "starting" | "ready" | "draining" | "stopped" | "unknown";
  };
  readonly planes: {
    readonly source: "daemon" | "offline-probe";
    readonly appServer: "available" | "unavailable" | "incompatible" | "unknown";
    readonly desktop: "available" | "unavailable";
  };
  readonly diagnostics: {
    readonly journalAvailable: boolean;
    readonly entries: number;
    readonly invalidEntries: number;
    readonly outcomeCounts: Partial<Record<DeliveryOutcomeTag, number>>;
    readonly stageCounts: Partial<Record<DeliveryStage, number>>;
    readonly recentFailures: ReadonlyArray<{
      readonly code: DiagnosticCode;
      readonly stage?: DeliveryStage;
      readonly route?: DeliveryRoute;
      readonly count: number;
    }>;
  };
}

export interface CompatibilityReportPreview {
  readonly payload: CompatibilityReportPayload;
  readonly consentRequired: true;
  readonly disclosure: typeof DISCLOSURE;
}

export interface AuthorizedCompatibilityReport {
  readonly payload: CompatibilityReportPayload;
  readonly consent: { readonly approved: true; readonly source: "doctor-cli" };
}

function reportPlatform(
  value: NodeJS.Platform,
): CompatibilityReportPayload["runtime"]["platform"] {
  return value === "darwin" || value === "linux" || value === "win32"
    ? value
    : "other";
}

function reportArchitecture(
  value: string,
): CompatibilityReportPayload["runtime"]["architecture"] {
  return value === "arm64" || value === "x64" ? value : "other";
}

function nodeMajor(value: string): number | null {
  const match = /^v?(\d+)/.exec(value);
  return match?.[1] == null ? null : Number(match[1]);
}

function daemonDetails(daemon: DaemonProbe): CompatibilityReportPayload["daemon"] {
  if (daemon.state === "running") {
    return { state: "running", phase: daemon.health.phase };
  }
  return {
    state: daemon.state === "down" ? "stopped" : "unreachable",
    phase: "unknown",
  };
}

function planes(
  input: CompatibilityReportInput,
): CompatibilityReportPayload["planes"] {
  if (input.daemon.state === "running") {
    return {
      source: "daemon",
      appServer: input.daemon.health.taskAccessStatus,
      desktop: input.daemon.health.desktopIpcAvailable
        ? "available"
        : "unavailable",
    };
  }
  return {
    source: "offline-probe",
    appServer: input.offlineAppServerCandidateFound ? "unknown" : "unavailable",
    desktop: input.offlineDesktopIpcAvailable ? "available" : "unavailable",
  };
}

function recordDiagnostics(record: DiagnosticRecord) {
  return record.type === "diagnostic"
    ? [record.diagnostic]
    : [
        ...record.attempts.flatMap((attempt) =>
          attempt.diagnostic == null ? [] : [attempt.diagnostic]
        ),
        ...(record.diagnostic == null ? [] : [record.diagnostic]),
      ];
}

function diagnosticSummary(snapshot: DiagnosticJournalSnapshot) {
  const outcomeCounts: Partial<Record<DeliveryOutcomeTag, number>> = {};
  const stageCounts: Partial<Record<DeliveryStage, number>> = {};
  const failures = new Map<string, {
    code: DiagnosticCode;
    stage?: DeliveryStage;
    route?: DeliveryRoute;
    count: number;
    lastIndex: number;
  }>();
  for (const [index, record] of snapshot.records.entries()) {
    if (record.type === "delivery-terminal") {
      outcomeCounts[record.outcome] = (outcomeCounts[record.outcome] ?? 0) + 1;
    }
    const uniqueDiagnostics = new Map<string, ReturnType<typeof recordDiagnostics>[number]>();
    for (const diagnostic of recordDiagnostics(record)) {
      const key = `${diagnostic.code}:${diagnostic.stage ?? ""}:${diagnostic.route ?? ""}`;
      uniqueDiagnostics.set(key, diagnostic);
    }
    for (const [key, diagnostic] of uniqueDiagnostics) {
      if (diagnostic.stage != null) {
        stageCounts[diagnostic.stage] = (stageCounts[diagnostic.stage] ?? 0) + 1;
      }
      const previous = failures.get(key);
      failures.set(key, {
        code: diagnostic.code,
        ...(diagnostic.stage == null ? {} : { stage: diagnostic.stage }),
        ...(diagnostic.route == null ? {} : { route: diagnostic.route }),
        count: (previous?.count ?? 0) + 1,
        lastIndex: index,
      });
    }
  }
  const recentFailures = [...failures.values()]
    .sort((left, right) => right.lastIndex - left.lastIndex)
    .slice(0, FAILURE_LIMIT)
    .map(({ lastIndex: _lastIndex, ...failure }) => failure);
  return { outcomeCounts, stageCounts, recentFailures };
}

export function buildCompatibilityReport(
  input: CompatibilityReportInput,
): CompatibilityReportPayload {
  const diagnostics = diagnosticSummary(input.journal);
  return {
    schemaVersion: 1,
    codexhookVersion: input.version,
    runtime: {
      platform: reportPlatform(input.platform),
      architecture: reportArchitecture(input.architecture),
      nodeMajor: nodeMajor(input.nodeVersion),
    },
    installation: {
      manifest: input.installation.manifest === true,
      runtime: input.installation.runtime === true,
      skill: input.installation.skill === true,
      service: input.installation.service === true,
      nodeCompatible: input.installation.nodeCompatible === true,
    },
    daemon: daemonDetails(input.daemon),
    planes: planes(input),
    diagnostics: {
      journalAvailable: input.journal.available,
      entries: input.journal.records.length,
      invalidEntries: input.journal.invalidLines,
      ...diagnostics,
    },
  };
}

export function previewCompatibilityReport(
  payload: CompatibilityReportPayload,
): CompatibilityReportPreview {
  return { payload, consentRequired: true, disclosure: DISCLOSURE };
}

export function authorizeCompatibilityReport(
  preview: CompatibilityReportPreview,
): AuthorizedCompatibilityReport {
  return {
    payload: preview.payload,
    consent: { approved: true, source: "doctor-cli" },
  };
}
