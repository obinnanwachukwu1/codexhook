import { turnOutcomeTruth, type TransportId, type TurnOutcome } from "../types.js";
import {
  deliveryTruth,
  errorTransport,
  type DeliveryError,
} from "../transport/errors.js";
import type { TransportAttemptStage } from "../transport/attempts.js";
import type {
  DiagnosticEvent,
  DiagnosticOutcome,
  DiagnosticStage,
  JournalCode,
} from "./contracts.js";

export function deliveryStartedEvent(): DiagnosticEvent {
  return {
    stage: "submission",
    outcome: "started",
    code: "submission.started",
  };
}

export function deliverySucceededEvent(outcome: TurnOutcome): DiagnosticEvent {
  return {
    stage: "submission",
    outcome: "succeeded",
    code: "submission.confirmed",
    transport: outcome.transport,
    deliveryTruth: turnOutcomeTruth(outcome),
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
        code: "canonical.unknown",
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
    case "ThreadBusy":
      return {
        stage: "state_synchronization",
        outcome: "unavailable",
        code: "state.resume_failed",
      };
  }
}

export function attemptStartedEvent(transport: TransportId): DiagnosticEvent {
  return transport === "desktop"
    ? {
        stage: "attachment",
        outcome: "started",
        code: "attachment.attempt_started",
        transport,
      }
    : {
        stage: "protocol",
        outcome: "started",
        code: "protocol.attempt_started",
        transport,
      };
}

export function attemptFailedEvent(
  transport: TransportId,
  attemptStage: TransportAttemptStage,
  error: DeliveryError,
): DiagnosticEvent {
  const terminal = deliveryFailedEvent(error);
  if (error._tag === "TransportUnavailable" && transport === "desktop") {
    const { deliveryTruth: _, ...attempt } = terminal;
    return { ...attempt, transport };
  }
  if (attemptStage === "resume" || attemptStage === "await") {
    return {
      stage: "state_synchronization",
      outcome: "failed",
      code: attemptStage === "resume" ? "state.resume_failed" : "state.await_failed",
      transport,
    };
  }
  const { deliveryTruth: _, ...attempt } = terminal;
  return { ...attempt, transport };
}
