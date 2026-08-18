import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorizeCompatibilityReport,
  buildCompatibilityReport,
  previewCompatibilityReport,
} from "../src/diagnostics/support-report.js";
import { deliveryFailedEvent } from "../src/diagnostics/events.js";
import { DiagnosticJournal } from "../src/diagnostics/journal.js";
import { recordDiagnostic } from "../src/diagnostics/contracts.js";
import {
  SubmitAmbiguous,
  TransportIncompatible,
  TransportUnavailable,
} from "../src/transport/errors.js";
import { DeliveryId, ThreadId } from "../src/types.js";
import { SyntheticCircuitBreaker } from "./support/synthetic-circuit-breaker.js";
import { doctor } from "../src/commands/system.js";

function journalFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhook-journal-"));
  const journal = new DiagnosticJournal(path.join(directory, "journal.jsonl"), {
    maxBytes: 1_024,
    maxEntries: 8,
  });
  return { directory, journal };
}

test("diagnostic journal is bounded and tolerates corrupt records", () => {
  const { journal } = journalFixture();
  for (let index = 0; index < 20; index += 1) {
    journal.record({
      stage: "submission",
      outcome: index % 2 === 0 ? "ambiguous" : "succeeded",
      code: index % 2 === 0
        ? "submission.ambiguous"
        : "submission.confirmed",
      deliveryTruth: index % 2 === 0
        ? "ambiguous"
        : "confirmed_app_server",
    });
  }
  assert.ok(Buffer.byteLength(readFileSync(journal.filePath)) <= 1_024);
  assert.ok(
    readFileSync(journal.filePath, "utf8").trim().split("\n").length <= 8,
  );
  appendFileSync(journal.filePath, "not-json\n");
  appendFileSync(journal.filePath, `${JSON.stringify({
    schemaVersion: 1,
    timestamp: "not-a-timestamp",
    stage: "protocol",
    outcome: "failed",
    code: "protocol.unavailable",
  })}\n`);
  const snapshot = journal.read();
  assert.ok(snapshot.records.length <= 8);
  assert.equal(snapshot.records.at(-1)?.deliveryTruth, "confirmed_app_server");
  assert.equal(snapshot.invalidLines, 2);
});

test("a broken diagnostic observer cannot affect delivery control flow", () => {
  assert.doesNotThrow(() =>
    recordDiagnostic({
      record() {
        throw new Error("observer failed");
      },
    }, {
      stage: "submission",
      outcome: "succeeded",
      code: "submission.confirmed",
    })
  );
});

test("doctor refuses consent without an explicit compatibility preview request", async () => {
  await assert.rejects(
    doctor(["--consent"]),
    /--consent requires --compatibility-report/,
  );
});

test("typed diagnostics cover every delivery decision stage", () => {
  const fixture = journalFixture();
  const journal = new DiagnosticJournal(fixture.journal.filePath, {
    maxBytes: 4_096,
    maxEntries: 32,
  });
  journal.record(deliveryFailedEvent(new TransportUnavailable({
    transport: "desktop",
    reason: "connect-failed",
    detail: "unavailable",
  })));
  journal.record(deliveryFailedEvent(new TransportIncompatible({
    transport: "daemon",
    stage: "initialize",
    detail: "incompatible",
  })));
  journal.record({
    stage: "fallback",
    outcome: "started",
    code: "fallback.attempted",
  });
  journal.record(deliveryFailedEvent(new SubmitAmbiguous({
    transport: "desktop",
    method: "turn/start",
    threadId: ThreadId("thread-1"),
    deliveryId: DeliveryId("delivery-1"),
    cause: "disconnected",
  })));
  journal.record({
    stage: "canonical_verification",
    outcome: "failed",
    code: "canonical.unknown",
  });
  journal.record({
    stage: "state_synchronization",
    outcome: "failed",
    code: "state.revision_gap",
  });
  const breaker = new SyntheticCircuitBreaker(journal);
  breaker.fail();
  breaker.probe();
  breaker.recover();

  const records = journal.read().records;
  const stages = new Set(records.map((record) => record.stage));
  assert.deepEqual(stages, new Set([
    "attachment",
    "protocol",
    "fallback",
    "submission",
    "canonical_verification",
    "state_synchronization",
    "circuit_breaker",
  ]));
  assert.equal(
    records.find((record) => record.code === "submission.ambiguous")
      ?.deliveryTruth,
    "ambiguous",
  );
  assert.equal(
    records.some((record) =>
      record.code === "circuit.recovered" && record.outcome === "recovered"
    ),
    true,
  );
});

test("compatibility payload is allowlisted, sanitized, and consent-gated", () => {
  const { journal } = journalFixture();
  journal.record({
    stage: "protocol",
    outcome: "failed",
    code: "protocol.incompatible",
    transport: "daemon",
  });
  const installation = {
    manifest: true,
    runtime: true,
    skill: true,
    service: true,
    nodeCompatible: true,
    secretPath: "/private/install",
  };
  const payload = buildCompatibilityReport({
    version: "9.8.7",
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    installation,
    daemonState: "running",
    desktopIpcAvailable: true,
    candidates: ["desktop", "daemon", "/secret/socket", "future-runtime"],
    journal: journal.read(),
    failures: journal.failures(),
  });
  const serialized = JSON.stringify(payload);
  assert.deepEqual(payload.codex.candidates, ["desktop", "daemon"]);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("timestamp"), false);
  assert.equal(serialized.includes("lastSeenAt"), false);

  const preview = previewCompatibilityReport(payload);
  assert.equal(preview.consentRequired, true);
  const authorized = authorizeCompatibilityReport(preview);
  assert.equal(authorized.consent.approved, true);
  assert.equal(authorized.consent.source, "doctor-cli");
});

test("journal failures preserve stage and truthful terminal classification", () => {
  const { journal } = journalFixture();
  journal.record({
    stage: "submission",
    outcome: "rejected",
    code: "submission.rejected",
    deliveryTruth: "rejected",
  });
  journal.record({
    stage: "canonical_verification",
    outcome: "failed",
    code: "canonical.unknown",
    deliveryTruth: "confirmed_app_server",
  });
  assert.deepEqual(
    journal.failures().map((failure) => ({
      stage: failure.stage,
      truth: failure.deliveryTruth,
    })).sort((left, right) => left.stage.localeCompare(right.stage)),
    [
      { stage: "canonical_verification", truth: "confirmed_app_server" },
      { stage: "submission", truth: "rejected" },
    ],
  );
});

test("journal failure summaries use the newest occurrence and honor their limit", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhook-journal-"));
  let tick = 0;
  const journal = new DiagnosticJournal(path.join(directory, "journal.jsonl"), {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  journal.record({
    stage: "protocol",
    outcome: "failed",
    code: "protocol.incompatible",
  });
  journal.record({
    stage: "attachment",
    outcome: "unavailable",
    code: "attachment.desktop_unavailable",
  });
  journal.record({
    stage: "protocol",
    outcome: "failed",
    code: "protocol.incompatible",
  });
  const failures = journal.failures(journal.read(), 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.code, "protocol.incompatible");
  assert.equal(failures[0]?.count, 2);
  assert.equal(failures[0]?.lastSeenAt, "2026-01-01T00:00:02.000Z");
});
