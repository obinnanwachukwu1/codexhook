import type { TransportId, TurnOutcome } from "../types.js";
import {
  deliveryTruth,
  errorTransport,
  type DeliveryError,
  type TryNextError,
} from "../transport/errors.js";
import { truthForTransport } from "../transport/truth.js";
import type { TransportAttemptStage } from "../transport/attempts.js";
import type { DesktopStateDiagnostic } from "../transport/desktop-state.js";
import type {
  DiagnosticEvent,
  DiagnosticOutcome,
  DiagnosticStage,
  JournalCode,
} from "./contracts.js";

export function deliverySucceededEvent(outcome: TurnOutcome): DiagnosticEvent {
  return {
    stage: "submission",
    outcome: "succeeded",
    code: "submission.confirmed",
    transport: outcome.transport,
    deliveryTruth: truthForTransport(outcome.transport),
  };
}

export function deliveryFailedEvent(error: DeliveryError): DiagnosticEvent {
  const transport = errorTransport(error);
  return {
    ...classifyDeliveryFailure(error),
    deliveryTruth: deliveryTruth(error),
    ...(transport == null ? {} : { transport }),
  };
}

type FailureClassification = Pick<
  DiagnosticEvent,
  "stage" | "outcome" | "code"
>;

function classifyDeliveryFailure(error: DeliveryError): FailureClassification {
  switch (error._tag) {
    case "SubmitAmbiguous":
    case "TurnAbandoned":
      return {
        stage: "submission",
        outcome: "ambiguous",
        code: "submission.ambiguous",
      };
    case "SubmitRejected":
      return {
        stage: "submission",
        outcome: "rejected",
        code: "submission.rejected",
      };
    case "TurnFailed":
      return {
        stage: "canonical_verification",
        outcome: "failed",
        code: "canonical.turn_failed",
      };
    case "TurnTimeout":
      return {
        stage: "canonical_verification",
        outcome: "failed",
        code: "canonical.turn_timeout",
      };
    case "DesktopVisibilityUnconfirmed":
      return {
        stage: "canonical_verification",
        outcome: "failed",
        code: error.reason === "turn-not-exposed"
          ? "canonical.absent"
          : "canonical.unknown",
      };
    case "NoTransportAvailable":
      return {
        stage: "fallback",
        outcome: "unavailable",
        code: "fallback.exhausted",
      };
    case "TransportIncompatible":
      return {
        stage: "protocol",
        outcome: "unavailable",
        code: error.stage === "malformed"
          ? "protocol.malformed_response"
          : "protocol.incompatible",
      };
    case "TransportUnavailable":
      return error.transport === "desktop"
        ? {
            stage: "attachment",
            outcome: "unavailable",
            code: "attachment.desktop_unavailable",
          }
        : {
            stage: "protocol",
            outcome: "unavailable",
            code: "protocol.unavailable",
          };
    case "ThreadUnavailable":
      return {
        stage: "state_synchronization",
        outcome: "unavailable",
        code: "state.resume_failed",
      };
    case "ThreadBusy":
      return {
        stage: "state_synchronization",
        outcome: "unavailable",
        code: "state.await_failed",
      };
  }
}

export function attemptFailedEvent(
  transport: TransportId,
  attemptStage: TransportAttemptStage,
  error: TryNextError,
): DiagnosticEvent {
  if (error._tag === "TransportUnavailable" && transport === "desktop") {
    return { ...classifyDeliveryFailure(error), transport };
  }
  if (
    error._tag === "TransportUnavailable" &&
    (attemptStage === "resume" || attemptStage === "await")
  ) {
    return {
      stage: "state_synchronization",
      outcome: "failed",
      code: attemptStage === "resume" ? "state.resume_failed" : "state.await_failed",
      transport,
    };
  }
  return { ...classifyDeliveryFailure(error), transport };
}

export function fallbackAttemptedEvent(
  transport: TransportId,
): DiagnosticEvent {
  return {
    stage: "fallback",
    outcome: "started",
    code: "fallback.attempted",
    transport,
  };
}

export function desktopConnectedEvent(): DiagnosticEvent {
  return {
    stage: "attachment",
    outcome: "succeeded",
    code: "attachment.desktop_connected",
    transport: "desktop",
  };
}

export function fallbackSelectedEvent(
  transport: TransportId,
): DiagnosticEvent {
  return {
    stage: "fallback",
    outcome: "succeeded",
    code: "fallback.selected",
    transport,
  };
}

export function canonicalFoundEvent(): DiagnosticEvent {
  return {
    stage: "canonical_verification",
    outcome: "succeeded",
    code: "canonical.found",
    transport: "desktop",
  };
}

export function canonicalUnknownEvent(): DiagnosticEvent {
  return {
    stage: "canonical_verification",
    outcome: "deferred",
    code: "canonical.unknown",
    transport: "desktop",
  };
}

const DESKTOP_STATE_EVENTS = {
  revision_gap: { outcome: "failed", code: "state.revision_gap" },
  resynchronized: { outcome: "recovered", code: "state.resynchronized" },
  reordered_patch: { outcome: "deferred", code: "state.reordered_patch" },
  stale_active_turn: {
    outcome: "deferred",
    code: "state.stale_active_turn",
  },
} as const satisfies Record<
  DesktopStateDiagnostic,
  Pick<DiagnosticEvent, "outcome" | "code">
>;

export function desktopStateEvent(
  event: DesktopStateDiagnostic,
): DiagnosticEvent {
  return {
    stage: "state_synchronization",
    ...DESKTOP_STATE_EVENTS[event],
    transport: "desktop",
  };
}

export function circuitBreakerEvent(
  transition: "opened" | "half-open" | "recovered",
): DiagnosticEvent {
  if (transition === "opened") {
    return {
      stage: "circuit_breaker",
      outcome: "failed",
      code: "circuit.opened",
    };
  }
  if (transition === "half-open") {
    return {
      stage: "circuit_breaker",
      outcome: "started",
      code: "circuit.half_open",
    };
  }
  return {
    stage: "circuit_breaker",
    outcome: "recovered",
    code: "circuit.recovered",
  };
}
