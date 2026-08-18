import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  authorizeCompatibilityReport,
  buildCompatibilityReport,
  previewCompatibilityReport,
} from "../src/diagnostics/compatibility.js";
import { DiagnosticJournal } from "../src/diagnostics/journal.js";
import { diagnosticLogObserver } from "../src/diagnostics/log-observer.js";
import { Logger } from "../src/logger.js";
import { Option } from "effect";
import {
  deliveryTruth,
  DesktopVisibilityUnconfirmed,
  SubmitAmbiguous,
  SubmitRejected,
  TurnFailed,
  TurnTimeout,
} from "../src/transport/errors.js";
import { DeliveryId, ThreadId, TurnId } from "../src/types.js";

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
  appendFileSync(journal.filePath, "not-json\n");
  const snapshot = journal.read();
  assert.ok(snapshot.records.length <= 8);
  assert.equal(snapshot.records.at(-1)?.deliveryTruth, "confirmed_app_server");
  assert.equal(snapshot.invalidLines, 1);
});

test("logger classification names every delivery decision stage", () => {
  const fixture = journalFixture();
  const journal = new DiagnosticJournal(fixture.journal.filePath, {
    maxBytes: 4_096,
    maxEntries: 32,
  });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const logger = new Logger(sink, [diagnosticLogObserver(journal)]);

  logger.warn("transport_attempt_failed", {
    transport: "desktop",
    stage: "connect",
    errorTag: "TransportUnavailable",
    tryNext: true,
    detail: "secret socket path",
  });
  logger.warn("transport_attempt_failed", {
    transport: "daemon",
    stage: "connect",
    errorTag: "TransportIncompatible",
    tryNext: false,
  });
  logger.error("delivery_failed", {
    errorTag: "SubmitAmbiguous",
    submission: "unknown",
    deliveryId: "secret-delivery-id",
    threadId: "secret-thread-id",
  });
  logger.error("desktop_visibility_failed", { transport: "desktop" });
  logger.warn("desktop_state_revision_gap", { transport: "desktop" });
  logger.warn("circuit_breaker_opened");
  logger.info("circuit_breaker_recovered");

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
  assert.equal(JSON.stringify(records).includes("secret"), false);
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
    daemonState: "running",
    desktopIpcAvailable: true,
    candidates: ["desktop", "daemon", "/secret/socket", "future-runtime"],
    journal: journal.read(),
    failures: journal.failures(),
  });
  const serialized = JSON.stringify(payload);
  assert.deepEqual(payload.codex.candidates, ["desktop", "daemon"]);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("timestamp"), false);
  assert.equal(serialized.includes("lastSeenAt"), false);

  const preview = previewCompatibilityReport(payload);
  assert.equal(preview.consentRequired, true);
  assert.throws(() => authorizeCompatibilityReport(preview, false));
  const authorized = authorizeCompatibilityReport(preview, true);
  assert.equal(authorized.consent.approved, true);
  assert.equal(authorized.consent.fingerprint, preview.fingerprint);
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

test("terminal delivery truth distinguishes confirmation from uncertainty", () => {
  const threadId = ThreadId("thread-1");
  const turnId = TurnId("turn-1");
  assert.equal(deliveryTruth(new SubmitAmbiguous({
    transport: "desktop",
    method: "turn/start",
    threadId,
    deliveryId: DeliveryId("delivery-1"),
    cause: "disconnected",
  })), "ambiguous");
  assert.equal(deliveryTruth(new SubmitRejected({
    transport: "daemon",
    method: "turn/start",
    code: -1,
    message: "rejected",
  })), "rejected");
  assert.equal(deliveryTruth(new TurnFailed({
    transport: "desktop",
    threadId,
    turnId,
    status: "failed",
    message: Option.none(),
  })), "confirmed_desktop");
  assert.equal(deliveryTruth(new TurnTimeout({
    transport: "cli",
    threadId,
    turnId,
    waitedMillis: 100,
  })), "confirmed_app_server");
  assert.equal(deliveryTruth(new DesktopVisibilityUnconfirmed({
    threadId,
    turnId,
    submittedTransport: "daemon",
    detail: "not visible",
  })), "confirmed_app_server");
});
