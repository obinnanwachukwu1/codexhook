import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DeliveryOutcome } from "../src/contracts/delivery.js";
import type { LocalTaskRef } from "../src/contracts/local-codex.js";
import { sanitizeDiagnostic } from "../src/contracts/diagnostics.js";
import {
  authorizeCompatibilityReport,
  buildCompatibilityReport,
  previewCompatibilityReport,
} from "../src/diagnostics/support-report.js";
import {
  DiagnosticJournal,
  recordDiagnosticSafely,
  recordOutcomeSafely,
} from "../src/diagnostics/journal.js";
import { DeliveryId, ThreadId, TurnId } from "../src/types.js";
import { doctor } from "../src/commands/system.js";

function fixture(options: { maxBytes?: number; maxEntries?: number } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhook-journal-"));
  const journal = new DiagnosticJournal(path.join(directory, "journal.jsonl"), {
    maxBytes: options.maxBytes ?? 1_024,
    maxEntries: options.maxEntries ?? 8,
  });
  return { directory, journal };
}

function task(): LocalTaskRef {
  return {
    threadId: ThreadId("private-thread"),
    origin: "cli",
  } as LocalTaskRef;
}

const diagnostic = sanitizeDiagnostic({
  code: "write-ambiguous",
  stage: "reconcile-app-server",
  route: "desktop",
  message: "private error text",
});

function outcomes(): ReadonlyArray<DeliveryOutcome> {
  const common = {
    task: task(),
    deliveryId: DeliveryId("private-delivery"),
    attempts: [{
      route: "desktop" as const,
      stage: "submit-desktop" as const,
      outcome: "Ambiguous" as const,
      elapsedMs: 250,
      diagnostic,
    }],
  };
  return [
    {
      ...common,
      _tag: "ConfirmedDesktop",
      turnId: TurnId("private-turn"),
      operation: "start",
    },
    {
      ...common,
      _tag: "ConfirmedAppServer",
      turnId: TurnId("private-turn"),
      operation: "steer",
    },
    { ...common, _tag: "Ambiguous", route: "desktop", diagnostic },
    { ...common, _tag: "Unavailable", diagnostic },
    { ...common, _tag: "Rejected", route: "desktop", diagnostic },
  ];
}

test("journal records all terminal truths without identifiers or free text", () => {
  const { directory, journal } = fixture({ maxBytes: 16_384 });
  try {
    for (const outcome of outcomes()) journal.recordOutcome(outcome);
    const records = journal.read().records;
    assert.deepEqual(records.map((record) =>
      record.type === "delivery-terminal" ? record.outcome : null
    ), [
      "ConfirmedDesktop",
      "ConfirmedAppServer",
      "Ambiguous",
      "Unavailable",
      "Rejected",
    ]);
    const serialized = readFileSync(journal.filePath, "utf8");
    for (const forbidden of [
      "private-thread",
      "private-delivery",
      "private-turn",
      "private error text",
      "elapsedMs",
    ]) assert.equal(serialized.includes(forbidden), false);
    if (process.platform !== "win32") {
      assert.equal(statSync(journal.filePath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable journal degrades without hiding doctor evidence", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhook-journal-"));
  try {
    const journal = new DiagnosticJournal(directory);
    assert.deepEqual(journal.read(), {
      records: [],
      invalidLines: 0,
      available: false,
      limits: { bytes: 256 * 1024, entries: 512 },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("journal is bounded and tolerates corrupt or noncanonical records", () => {
  const { directory, journal } = fixture();
  try {
    for (let index = 0; index < 30; index += 1) {
      journal.recordDiagnostic(sanitizeDiagnostic({
        code: index % 2 === 0 ? "timeout" : "disconnected",
        stage: "submit-app-server",
        route: "app-server",
      }));
    }
    assert.ok(Buffer.byteLength(readFileSync(journal.filePath)) <= 1_024);
    assert.ok(readFileSync(journal.filePath, "utf8").trim().split("\n").length <= 8);
    appendFileSync(journal.filePath, "not-json\n");
    appendFileSync(journal.filePath, `${JSON.stringify({
      schemaVersion: 1,
      timestamp: "not-a-time",
      type: "diagnostic",
      diagnostic: { code: "timeout" },
    })}\n`);
    const snapshot = journal.read();
    assert.ok(snapshot.records.length <= 8);
    assert.equal(snapshot.invalidLines, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a broken recorder cannot affect delivery control flow", () => {
  const recorder = {
    recordOutcome() {
      throw new Error("recorder failed");
    },
    recordDiagnostic() {
      throw new Error("recorder failed");
    },
  };
  assert.doesNotThrow(() => recordOutcomeSafely(recorder, outcomes()[0]!));
  assert.doesNotThrow(() => recordDiagnosticSafely(recorder, diagnostic));
});

test("doctor requires an explicit local report before consent", async () => {
  await assert.rejects(
    doctor(["--consent"]),
    /--consent requires --compatibility-report/,
  );
});

test("compatibility payload is allowlisted, local, and consent-gated", () => {
  const { directory, journal } = fixture({ maxBytes: 16_384 });
  try {
    journal.recordOutcome(outcomes()[2]!);
    const payload = buildCompatibilityReport({
      version: "9.8.7",
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      installation: {
        manifest: true,
        runtime: true,
        skill: true,
        service: true,
        nodeCompatible: true,
      },
      daemon: {
        state: "running",
        health: {
          state: "available",
          version: "9.8.7",
          desktopIpcAvailable: true,
          phase: "ready",
          taskAccessStatus: "available",
        },
      },
      offlineDesktopIpcAvailable: false,
      offlineAppServerCandidateFound: false,
      journal: journal.read(),
    });
    assert.deepEqual(payload.planes, {
      source: "daemon",
      appServer: "available",
      desktop: "available",
    });
    assert.equal(payload.diagnostics.outcomeCounts.Ambiguous, 1);
    assert.equal(payload.diagnostics.journalAvailable, true);
    assert.equal(payload.diagnostics.recentFailures[0]?.count, 1);
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      "private-thread",
      "private-delivery",
      "private-turn",
      "timestamp",
      "filePath",
      "lastSeenAt",
    ]) assert.equal(serialized.includes(forbidden), false);
    const preview = previewCompatibilityReport(payload);
    assert.equal(preview.consentRequired, true);
    assert.match(preview.disclosure.join(" "), /Nothing is transmitted/);
    assert.deepEqual(authorizeCompatibilityReport(preview).consent, {
      approved: true,
      source: "doctor-cli",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline compatibility uses probes without inventing compatibility", () => {
  const { directory, journal } = fixture();
  try {
    const payload = buildCompatibilityReport({
      version: "1.0.0",
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      installation: {
        manifest: false,
        runtime: false,
        skill: false,
        service: false,
        nodeCompatible: true,
      },
      daemon: { state: "down" },
      offlineDesktopIpcAvailable: true,
      offlineAppServerCandidateFound: true,
      journal: journal.read(),
    });
    assert.deepEqual(payload.planes, {
      source: "offline-probe",
      appServer: "unknown",
      desktop: "available",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
