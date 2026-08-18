import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureDataDirectory } from "../config.js";
import type {
  DeliveryAttempt,
  DeliveryOutcome,
} from "../contracts/delivery.js";
import {
  sanitizeDiagnostic,
  type SanitizedDiagnostic,
} from "../contracts/diagnostics.js";
import { isDeliveryStage, type DeliveryStage } from "../contracts/stages.js";
import type { DeliveryRoute } from "../contracts/submission.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 512;
const ROTATION_RATIO = 0.75;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

export const DELIVERY_OUTCOMES = [
  "ConfirmedDesktop",
  "ConfirmedAppServer",
  "Ambiguous",
  "Unavailable",
  "Rejected",
] as const;
export type DeliveryOutcomeTag = (typeof DELIVERY_OUTCOMES)[number];

export interface JournalAttempt {
  readonly route: DeliveryRoute;
  readonly stage: DeliveryStage;
  readonly outcome: "Confirmed" | "NotSubmitted" | "Ambiguous" | "Rejected";
  readonly diagnostic?: SanitizedDiagnostic;
}

export type DiagnosticRecord =
  | {
      readonly schemaVersion: 1;
      readonly timestamp: string;
      readonly type: "delivery-terminal";
      readonly outcome: DeliveryOutcomeTag;
      readonly attempts: ReadonlyArray<JournalAttempt>;
      readonly diagnostic?: SanitizedDiagnostic;
    }
  | {
      readonly schemaVersion: 1;
      readonly timestamp: string;
      readonly type: "diagnostic";
      readonly diagnostic: SanitizedDiagnostic;
    };

export interface DiagnosticRecorder {
  readonly recordOutcome: (outcome: DeliveryOutcome) => void;
  readonly recordDiagnostic: (diagnostic: SanitizedDiagnostic) => void;
}

export const NO_DIAGNOSTICS: DiagnosticRecorder = Object.freeze({
  recordOutcome() {},
  recordDiagnostic() {},
});

export interface DiagnosticJournalOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

export interface DiagnosticJournalSnapshot {
  readonly records: ReadonlyArray<DiagnosticRecord>;
  readonly invalidLines: number;
  readonly available: boolean;
  readonly limits: { readonly bytes: number; readonly entries: number };
}

function isRoute(value: unknown): value is DeliveryRoute {
  return value === "desktop" || value === "app-server";
}

function isAttemptOutcome(value: unknown): value is JournalAttempt["outcome"] {
  return value === "Confirmed" || value === "NotSubmitted" ||
    value === "Ambiguous" || value === "Rejected";
}

function isOutcomeTag(value: unknown): value is DeliveryOutcomeTag {
  return DELIVERY_OUTCOMES.some((tag) => tag === value);
}

function parseDiagnostic(value: unknown): SanitizedDiagnostic | null {
  if (value == null || typeof value !== "object") return null;
  return sanitizeDiagnostic(value);
}

function parseAttempt(value: unknown): JournalAttempt | null {
  if (value == null || typeof value !== "object") return null;
  const attempt = value as Record<string, unknown>;
  if (
    !isRoute(attempt.route) || !isDeliveryStage(attempt.stage) ||
    !isAttemptOutcome(attempt.outcome)
  ) return null;
  const diagnostic = attempt.diagnostic == null
    ? undefined
    : parseDiagnostic(attempt.diagnostic);
  if (attempt.diagnostic != null && diagnostic == null) return null;
  return {
    route: attempt.route,
    stage: attempt.stage,
    outcome: attempt.outcome,
    ...(diagnostic == null ? {} : { diagnostic }),
  };
}

function parseRecord(value: unknown): DiagnosticRecord | null {
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 || typeof record.timestamp !== "string" ||
    !ISO_TIMESTAMP.test(record.timestamp)
  ) return null;
  if (record.type === "diagnostic") {
    const diagnostic = parseDiagnostic(record.diagnostic);
    return diagnostic == null ? null : {
      schemaVersion: 1,
      timestamp: record.timestamp,
      type: "diagnostic",
      diagnostic,
    };
  }
  if (
    record.type !== "delivery-terminal" || !isOutcomeTag(record.outcome) ||
    !Array.isArray(record.attempts)
  ) return null;
  const attempts = record.attempts.map(parseAttempt);
  if (attempts.some((attempt) => attempt == null)) return null;
  const diagnostic = record.diagnostic == null
    ? undefined
    : parseDiagnostic(record.diagnostic);
  if (record.diagnostic != null && diagnostic == null) return null;
  return {
    schemaVersion: 1,
    timestamp: record.timestamp,
    type: "delivery-terminal",
    outcome: record.outcome,
    attempts: attempts as JournalAttempt[],
    ...(diagnostic == null ? {} : { diagnostic }),
  };
}

function journalAttempt(attempt: DeliveryAttempt): JournalAttempt {
  return {
    route: attempt.route,
    stage: attempt.stage,
    outcome: attempt.outcome,
    ...(attempt.diagnostic == null
      ? {}
      : { diagnostic: sanitizeDiagnostic(attempt.diagnostic) }),
  };
}

function terminalDiagnostic(outcome: DeliveryOutcome) {
  return outcome._tag === "Ambiguous" || outcome._tag === "Unavailable" ||
      outcome._tag === "Rejected"
    ? sanitizeDiagnostic(outcome.diagnostic)
    : undefined;
}

export function recordOutcomeSafely(
  recorder: DiagnosticRecorder,
  outcome: DeliveryOutcome,
): void {
  try {
    recorder.recordOutcome(outcome);
  } catch {
    // Observability must never change delivery truth or control flow.
  }
}

export function recordDiagnosticSafely(
  recorder: DiagnosticRecorder,
  diagnostic: SanitizedDiagnostic,
): void {
  try {
    recorder.recordDiagnostic(sanitizeDiagnostic(diagnostic));
  } catch {
    // Observability must never change delivery truth or control flow.
  }
}

export class DiagnosticJournal implements DiagnosticRecorder {
  private bytesOnDisk: number | null = null;
  private directoryReady = false;
  private entriesOnDisk: number | null = null;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(
    readonly filePath: string,
    options: DiagnosticJournalOptions = {},
  ) {
    this.maxBytes = Math.max(1_024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxEntries = Math.max(8, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? (() => new Date());
  }

  recordOutcome(outcome: DeliveryOutcome): void {
    const diagnostic = terminalDiagnostic(outcome);
    this.append({
      schemaVersion: 1,
      timestamp: this.now().toISOString(),
      type: "delivery-terminal",
      outcome: outcome._tag,
      attempts: outcome.attempts.map(journalAttempt),
      ...(diagnostic == null ? {} : { diagnostic }),
    });
  }

  recordDiagnostic(diagnostic: SanitizedDiagnostic): void {
    this.append({
      schemaVersion: 1,
      timestamp: this.now().toISOString(),
      type: "diagnostic",
      diagnostic: sanitizeDiagnostic(diagnostic),
    });
  }

  read(): DiagnosticJournalSnapshot {
    try {
      const snapshot = this.readAll();
      return { ...snapshot, records: snapshot.records.slice(-this.maxEntries) };
    } catch {
      return {
        records: [],
        invalidLines: 0,
        available: false,
        limits: { bytes: this.maxBytes, entries: this.maxEntries },
      };
    }
  }

  private append(record: DiagnosticRecord): void {
    try {
      this.ensureDirectory();
      if (this.entriesOnDisk == null || this.bytesOnDisk == null) {
        const usage = this.diskUsage();
        this.entriesOnDisk = usage.entries;
        this.bytesOnDisk = usage.bytes;
      }
      const line = `${JSON.stringify(record)}\n`;
      appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
      this.entriesOnDisk += 1;
      this.bytesOnDisk += Buffer.byteLength(line);
      this.enforceBounds();
    } catch {
      this.bytesOnDisk = null;
      this.directoryReady = false;
      this.entriesOnDisk = null;
    }
  }

  private ensureDirectory(): void {
    if (this.directoryReady) return;
    ensureDataDirectory(path.dirname(this.filePath));
    if (existsSync(this.filePath)) chmodSync(this.filePath, 0o600);
    this.directoryReady = true;
  }

  private enforceBounds(): void {
    if (
      (this.entriesOnDisk ?? 0) <= this.maxEntries &&
      (this.bytesOnDisk ?? 0) <= this.maxBytes
    ) return;
    const records = this.readAll().records;
    const targetEntries = Math.max(1, Math.floor(this.maxEntries * ROTATION_RATIO));
    const targetBytes = Math.max(1, Math.floor(this.maxBytes * ROTATION_RATIO));
    const kept: string[] = [];
    let bytes = 0;
    for (const record of records.slice().reverse()) {
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (kept.length >= targetEntries || bytes + lineBytes > targetBytes) break;
      kept.push(line);
      bytes += lineBytes;
    }
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, kept.reverse().join(""), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.filePath);
    this.bytesOnDisk = bytes;
    this.entriesOnDisk = kept.length;
  }

  private diskUsage(): { readonly bytes: number; readonly entries: number } {
    if (!existsSync(this.filePath)) return { bytes: 0, entries: 0 };
    const contents = readFileSync(this.filePath, "utf8");
    return {
      bytes: Buffer.byteLength(contents),
      entries: contents.split("\n").filter(Boolean).length,
    };
  }

  private readAll(): DiagnosticJournalSnapshot {
    if (!existsSync(this.filePath)) {
      return {
        records: [],
        invalidLines: 0,
        available: true,
        limits: { bytes: this.maxBytes, entries: this.maxEntries },
      };
    }
    let invalidLines = 0;
    const records: DiagnosticRecord[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        const record = parseRecord(JSON.parse(line));
        if (record == null) invalidLines += 1;
        else records.push(record);
      } catch {
        invalidLines += 1;
      }
    }
    return {
      records,
      invalidLines,
      available: true,
      limits: { bytes: this.maxBytes, entries: this.maxEntries },
    };
  }
}
