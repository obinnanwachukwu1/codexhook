import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureDataDirectory } from "../config.js";
import {
  diagnosticCode,
  type DiagnosticEvent,
  type DiagnosticFailureSummary,
  type DiagnosticObserver,
  type DiagnosticRecord,
  isDeliveryTruth,
  isDiagnosticOutcome,
  isDiagnosticStage,
} from "./contracts.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 512;

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
    !isDiagnosticStage(record.stage) ||
    !isDiagnosticOutcome(record.outcome)
  ) return null;
  const transport = ["desktop", "daemon", "app-bundled", "cli"].includes(
    String(record.transport),
  ) ? record.transport as DiagnosticRecord["transport"] : undefined;
  const deliveryTruth = isDeliveryTruth(record.deliveryTruth)
    ? record.deliveryTruth
    : undefined;
  return {
    schemaVersion: 1,
    timestamp: record.timestamp,
    stage: record.stage,
    outcome: record.outcome,
    code: diagnosticCode(record.code),
    ...(transport == null ? {} : { transport }),
    ...(deliveryTruth == null ? {} : { deliveryTruth }),
  };
}

export class DiagnosticJournal implements DiagnosticObserver {
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
      ensureDataDirectory(path.dirname(this.filePath));
      const value: DiagnosticRecord = {
        schemaVersion: 1,
        timestamp: this.now().toISOString(),
        stage: event.stage,
        outcome: event.outcome,
        code: diagnosticCode(event.code),
        ...(event.transport == null ? {} : { transport: event.transport }),
        ...(event.deliveryTruth == null
          ? {}
          : { deliveryTruth: event.deliveryTruth }),
      };
      appendFileSync(this.filePath, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.enforceBounds();
    } catch {
      // Diagnostics are best effort and must never affect delivery.
    }
  }

  read(): DiagnosticJournalSnapshot {
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
      records: records.slice(-this.maxEntries),
      invalidLines,
      boundedBy: { bytes: this.maxBytes, entries: this.maxEntries },
    };
  }

  failures(limit = 12): ReadonlyArray<DiagnosticFailureSummary> {
    const summaries = new Map<string, DiagnosticFailureSummary>();
    for (const record of this.read().records) {
      if (!["failed", "ambiguous", "unavailable", "rejected"].includes(
        record.outcome,
      )) continue;
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

  private enforceBounds(): void {
    if (
      statSync(this.filePath).size <= this.maxBytes &&
      this.read().records.length <= this.maxEntries
    ) return;
    const records = this.read().records;
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
    writeFileSync(this.filePath, kept.reverse().join(""), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(this.filePath, 0o600);
  }
}
