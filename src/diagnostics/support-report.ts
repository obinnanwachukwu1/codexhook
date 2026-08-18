import {
  JOURNAL_FAILURE_LIMIT,
  type DiagnosticJournalSnapshot,
} from "./journal.js";
import type {
  DeliveryTruth,
  DiagnosticFailureSummary,
  DiagnosticStage,
  JournalCode,
} from "./contracts.js";
import { isTransportId } from "./contracts.js";
import type { TransportId } from "../types.js";
import type { DaemonProbe } from "../daemon-control.js";

const DISCLOSURE = [
  "No task, turn, delivery, hook, path, message, or secret identifiers are included.",
  "Nothing is transmitted; this command only previews a local payload.",
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
  readonly daemonState: DaemonProbe["state"];
  readonly desktopIpcAvailable: boolean;
  readonly candidates: ReadonlyArray<unknown>;
  readonly journal: DiagnosticJournalSnapshot;
  readonly failures: ReadonlyArray<DiagnosticFailureSummary>;
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
  readonly daemonState: "running" | "stopped" | "unreachable" | "unknown";
  readonly codex: {
    readonly desktopIpcAvailable: boolean;
    readonly candidates: ReadonlyArray<TransportId>;
  };
  readonly diagnostics: {
    readonly entries: number;
    readonly invalidEntries: number;
    readonly stageCounts: Partial<Record<DiagnosticStage, number>>;
    readonly truthCounts: Partial<Record<DeliveryTruth, number>>;
    readonly recentFailures: ReadonlyArray<{
      readonly stage: DiagnosticStage;
      readonly code: JournalCode;
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
  readonly consent: {
    readonly approved: true;
    readonly source: "doctor-cli";
  };
}

function daemonState(
  value: DaemonProbe["state"],
): CompatibilityReportPayload["daemonState"] {
  switch (value) {
    case "running":
      return "running";
    case "down":
      return "stopped";
    case "occupied":
      return "unreachable";
  }
}

function reportPlatform(
  value: NodeJS.Platform,
): CompatibilityReportPayload["runtime"]["platform"] {
  switch (value) {
    case "darwin":
    case "linux":
    case "win32":
      return value;
    default:
      return "other";
  }
}

function reportArchitecture(
  value: string,
): CompatibilityReportPayload["runtime"]["architecture"] {
  switch (value) {
    case "arm64":
    case "x64":
      return value;
    default:
      return "other";
  }
}

export function buildCompatibilityReport(
  input: CompatibilityReportInput,
): CompatibilityReportPayload {
  const stageCounts: Partial<Record<DiagnosticStage, number>> = {};
  const truthCounts: Partial<Record<DeliveryTruth, number>> = {};
  for (const record of input.journal.records) {
    stageCounts[record.stage] = (stageCounts[record.stage] ?? 0) + 1;
    if (record.deliveryTruth != null) {
      truthCounts[record.deliveryTruth] =
        (truthCounts[record.deliveryTruth] ?? 0) + 1;
    }
  }
  const candidates = input.candidates.filter(
    (candidate): candidate is TransportId => isTransportId(candidate),
  );
  const match = /^v?(\d+)/.exec(input.nodeVersion);
  return {
    schemaVersion: 1,
    codexhookVersion: input.version,
    runtime: {
      platform: reportPlatform(input.platform),
      architecture: reportArchitecture(input.architecture),
      nodeMajor: match?.[1] == null ? null : Number(match[1]),
    },
    installation: {
      manifest: input.installation.manifest === true,
      runtime: input.installation.runtime === true,
      skill: input.installation.skill === true,
      service: input.installation.service === true,
      nodeCompatible: input.installation.nodeCompatible === true,
    },
    daemonState: daemonState(input.daemonState),
    codex: {
      desktopIpcAvailable: input.desktopIpcAvailable,
      candidates: [...new Set(candidates)],
    },
    diagnostics: {
      entries: input.journal.records.length,
      invalidEntries: input.journal.invalidLines,
      stageCounts,
      truthCounts,
      recentFailures: input.failures
        .slice(0, JOURNAL_FAILURE_LIMIT)
        .map((failure) => ({
          stage: failure.stage,
          code: failure.code,
          count: failure.count,
        })),
    },
  };
}

export function previewCompatibilityReport(
  payload: CompatibilityReportPayload,
): CompatibilityReportPreview {
  return {
    payload,
    consentRequired: true,
    disclosure: DISCLOSURE,
  };
}

export function authorizeCompatibilityReport(
  preview: CompatibilityReportPreview,
): AuthorizedCompatibilityReport {
  return {
    payload: preview.payload,
    consent: {
      approved: true,
      source: "doctor-cli",
    },
  };
}
