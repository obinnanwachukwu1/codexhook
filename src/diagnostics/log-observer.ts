import type { LogEntry, LogObserver } from "../logger.js";
import type { TransportId } from "../types.js";
import type {
  DiagnosticCode,
  DiagnosticEvent,
  DiagnosticObserver,
  DiagnosticOutcome,
  DiagnosticStage,
} from "./contracts.js";
import { isDeliveryTruth } from "./contracts.js";
import type { DeliveryTruth } from "../types.js";

function transport(value: unknown): TransportId | undefined {
  return ["desktop", "daemon", "app-bundled", "cli"].includes(String(value))
    ? value as TransportId
    : undefined;
}

function attemptFailure(entry: LogEntry): DiagnosticEvent {
  const errorTag = String(entry.errorTag ?? "");
  const selectedTransport = transport(entry.transport);
  let stage: DiagnosticStage = "protocol";
  let outcome: DiagnosticOutcome = "failed";
  let code: DiagnosticCode = "protocol.unavailable";
  if (errorTag === "TransportIncompatible") {
    code = String(entry.detail).includes("malformed")
      ? "protocol.malformed_response"
      : "protocol.incompatible";
  } else if (errorTag === "SubmitAmbiguous") {
    stage = "submission";
    outcome = "ambiguous";
    code = "submission.ambiguous";
  } else if (errorTag === "SubmitRejected") {
    stage = "submission";
    outcome = "rejected";
    code = "submission.rejected";
  } else if (selectedTransport === "desktop") {
    stage = "attachment";
    outcome = "unavailable";
    code = "attachment.desktop_unavailable";
  } else if (entry.stage === "resume") {
    stage = "state_synchronization";
    code = "state.resume_failed";
  } else if (entry.stage === "await") {
    stage = "state_synchronization";
    code = "state.await_failed";
  }
  return {
    stage,
    outcome,
    code,
    ...(selectedTransport == null ? {} : { transport: selectedTransport }),
  };
}

function deliveryFailure(entry: LogEntry): DiagnosticEvent {
  const errorTag = String(entry.errorTag ?? "");
  const selectedTransport = transport(entry.transport);
  let stage: DiagnosticStage = "submission";
  let outcome: DiagnosticOutcome = "failed";
  let code: DiagnosticCode = "submission.unavailable";
  let deliveryTruth: DeliveryTruth = isDeliveryTruth(entry.deliveryTruth)
    ? entry.deliveryTruth
    : "unavailable";
  if (errorTag === "SubmitAmbiguous" || entry.submission === "unknown") {
    outcome = "ambiguous";
    code = "submission.ambiguous";
    deliveryTruth = "ambiguous";
  } else if (errorTag === "SubmitRejected") {
    outcome = "rejected";
    code = "submission.rejected";
    deliveryTruth = "rejected";
  } else if (errorTag === "DesktopVisibilityUnconfirmed") {
    stage = "canonical_verification";
    code = "canonical.unknown";
    deliveryTruth = "confirmed_app_server";
  } else if (errorTag === "NoTransportAvailable") {
    stage = "fallback";
    outcome = "unavailable";
    code = "fallback.exhausted";
  }
  return {
    stage,
    outcome,
    code,
    deliveryTruth,
    ...(selectedTransport == null ? {} : { transport: selectedTransport }),
  };
}

function primaryEvent(entry: LogEntry): DiagnosticEvent | null {
  const selectedTransport = transport(entry.transport);
  switch (entry.event) {
    case "transport_attempt_started":
      return selectedTransport === "desktop"
        ? { stage: "attachment", outcome: "started", code: "attachment.attempt_started", transport: "desktop" }
        : {
            stage: "protocol",
            outcome: "started",
            code: "protocol.attempt_started",
            ...(selectedTransport == null ? {} : { transport: selectedTransport }),
          };
    case "transport_attempt_failed":
      return attemptFailure(entry);
    case "transport_attempt_succeeded":
      return selectedTransport === "desktop"
        ? { stage: "attachment", outcome: "succeeded", code: "attachment.desktop_connected", transport: "desktop" }
        : null;
    case "desktop_visibility_confirmed":
      return { stage: "canonical_verification", outcome: "succeeded", code: "canonical.found", transport: "desktop" };
    case "desktop_visibility_deferred":
      return { stage: "canonical_verification", outcome: "deferred", code: "canonical.unknown", transport: "desktop" };
    case "desktop_visibility_failed":
      return { stage: "canonical_verification", outcome: "failed", code: "canonical.unknown", transport: "desktop" };
    case "delivery_started":
      return { stage: "submission", outcome: "started", code: "submission.started" };
    case "delivery_finished": {
      const truth = isDeliveryTruth(entry.deliveryTruth)
        ? entry.deliveryTruth
        : selectedTransport === "desktop"
          ? "confirmed_desktop" as const
          : "confirmed_app_server" as const;
      return {
        stage: "submission",
        outcome: "succeeded",
        code: "submission.confirmed",
        deliveryTruth: truth,
        ...(selectedTransport == null ? {} : { transport: selectedTransport }),
      };
    }
    case "delivery_failed":
      return deliveryFailure(entry);
    case "desktop_state_revision_gap":
      return { stage: "state_synchronization", outcome: "failed", code: "state.revision_gap", transport: "desktop" };
    case "desktop_state_resynchronized":
      return { stage: "state_synchronization", outcome: "recovered", code: "state.resynchronized", transport: "desktop" };
    case "desktop_state_reordered_patch":
      return { stage: "state_synchronization", outcome: "recovered", code: "state.reordered_patch", transport: "desktop" };
    case "desktop_state_stale_active_turn":
      return { stage: "state_synchronization", outcome: "recovered", code: "state.stale_active_turn", transport: "desktop" };
    case "circuit_breaker_opened":
      return { stage: "circuit_breaker", outcome: "failed", code: "circuit.opened" };
    case "circuit_breaker_half_open":
      return { stage: "circuit_breaker", outcome: "started", code: "circuit.half_open" };
    case "circuit_breaker_recovered":
      return { stage: "circuit_breaker", outcome: "recovered", code: "circuit.recovered" };
    default:
      return null;
  }
}

export function diagnosticLogObserver(observer: DiagnosticObserver): LogObserver {
  return {
    observe(entry) {
      const primary = primaryEvent(entry);
      if (primary != null) observer.record(primary);
      if (
        entry.event === "transport_attempt_failed" &&
        entry.tryNext === true
      ) {
        const selectedTransport = transport(entry.transport);
        observer.record({
          stage: "fallback",
          outcome: "started",
          code: "fallback.attempted",
          ...(selectedTransport == null ? {} : { transport: selectedTransport }),
        });
      }
      if (
        entry.event === "transport_selected" &&
        Number(entry.priorFailures ?? 0) > 0
      ) {
        const selectedTransport = transport(entry.transport);
        observer.record({
          stage: "fallback",
          outcome: "succeeded",
          code: "fallback.selected",
          ...(selectedTransport == null ? {} : { transport: selectedTransport }),
        });
      }
    },
  };
}
