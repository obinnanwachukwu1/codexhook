import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureDataDirectory } from "../config.js";
import {
  isDeliveryTruth,
  isDiagnosticOutcome,
  isDiagnosticStage,
  isTransportId,
  journalCode,
  type DiagnosticEvent,
  type DiagnosticFailureSummary,
  type DiagnosticObserver,
  type DiagnosticOutcome,
  type DiagnosticRecord,
} from "./contracts.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 512;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const FAILURE_OUTCOMES = new Set<DiagnosticOutcome>([
  "failed",
  "ambiguous",
  "unavailable",
  "rejected",
]);
export const JOURNAL_FAILURE_LIMIT = 12;

export interface DiagnosticJournalOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

export interface DiagnosticJournalSnapshot {
  readonly records: ReadonlyArray<DiagnosticRecord>;
  readonly invalidLines: number;
  readonly boundedBy: { readonly bytes: number; readonly entries: number };
}

function parseRecord(value: unknown): DiagnosticRecord | null {
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.timestamp !== "string" ||
    !ISO_TIMESTAMP.test(record.timestamp) ||
    !isDiagnosticStage(record.stage) ||
    !isDiagnosticOutcome(record.outcome)
  ) return null;
  const transport = isTransportId(record.transport)
    ? record.transport
    : undefined;
  const deliveryTruth = isDeliveryTruth(record.deliveryTruth)
    ? record.deliveryTruth
    : undefined;
  return {
    schemaVersion: 1,
    timestamp: record.timestamp,
    stage: record.stage,
    outcome: record.outcome,
    code: journalCode(record.code),
    ...(transport == null ? {} : { transport }),
    ...(deliveryTruth == null ? {} : { deliveryTruth }),
  };
}

export class DiagnosticJournal implements DiagnosticObserver {
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

  record(event: DiagnosticEvent): void {
    try {
      this.ensureDirectory();
      if (this.entriesOnDisk == null) {
        this.entriesOnDisk = this.lineCount();
      }
      const value: DiagnosticRecord = {
        schemaVersion: 1,
        timestamp: this.now().toISOString(),
        stage: event.stage,
        outcome: event.outcome,
        code: journalCode(event.code),
        ...(event.transport == null ? {} : { transport: event.transport }),
        ...(event.deliveryTruth == null
          ? {}
          : { deliveryTruth: event.deliveryTruth }),
      };
      appendFileSync(this.filePath, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.entriesOnDisk += 1;
      this.enforceBounds();
    } catch {
      // Diagnostics are best effort and must never affect delivery.
    }
  }

  read(): DiagnosticJournalSnapshot {
    const snapshot = this.readAll();
    return {
      ...snapshot,
      records: snapshot.records.slice(-this.maxEntries),
    };
  }

  failures(
    snapshot = this.read(),
    limit = JOURNAL_FAILURE_LIMIT,
  ): ReadonlyArray<DiagnosticFailureSummary> {
    const summaries = new Map<string, DiagnosticFailureSummary>();
    for (const record of snapshot.records) {
      if (!FAILURE_OUTCOMES.has(record.outcome)) continue;
      const key = `${record.stage}:${record.code}:${record.outcome}:${record.deliveryTruth ?? ""}`;
      const previous = summaries.get(key);
      summaries.set(key, {
        stage: record.stage,
        code: record.code,
        outcome: record.outcome,
        count: (previous?.count ?? 0) + 1,
        lastSeenAt: record.timestamp,
        ...(record.deliveryTruth == null
          ? {}
          : { deliveryTruth: record.deliveryTruth }),
      });
    }
    return [...summaries.values()]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, Math.max(0, limit));
  }

  private ensureDirectory(): void {
    if (this.directoryReady) return;
    ensureDataDirectory(path.dirname(this.filePath));
    this.directoryReady = true;
  }

  private enforceBounds(): void {
    if (
      (this.entriesOnDisk ?? 0) <= this.maxEntries &&
      statSync(this.filePath).size <= this.maxBytes
    ) return;
    const records = this.readAll().records;
    const kept: string[] = [];
    let bytes = 0;
    for (const record of records.slice().reverse()) {
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (kept.length >= this.maxEntries || bytes + lineBytes > this.maxBytes) {
        break;
      }
      kept.push(line);
      bytes += lineBytes;
    }
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, kept.reverse().join(""), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.filePath);
    if (process.platform !== "win32") chmodSync(this.filePath, 0o600);
    this.entriesOnDisk = kept.length;
  }

  private lineCount(): number {
    if (!existsSync(this.filePath)) return 0;
    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .length;
  }

  private readAll(): DiagnosticJournalSnapshot {
    if (!existsSync(this.filePath)) {
      return {
        records: [],
        invalidLines: 0,
        boundedBy: { bytes: this.maxBytes, entries: this.maxEntries },
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
      boundedBy: { bytes: this.maxBytes, entries: this.maxEntries },
    };
  }
}
