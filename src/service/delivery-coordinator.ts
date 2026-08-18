import type { TurnOutcome } from "../types.js";
import {
  disposition,
  type DeliveryError,
} from "../transport/errors.js";

export type DeliveryTruth =
  | {
      readonly state: "confirmed-desktop";
      readonly outcome: TurnOutcome | null;
    }
  | {
      readonly state: "confirmed-app-server";
      readonly outcome: TurnOutcome | null;
      readonly transport: string;
    }
  | {
      readonly state: "ambiguous";
      readonly errorTag: string;
    }
  | {
      readonly state: "unavailable";
      readonly errorTag: string;
    }
  | {
      readonly state: "rejected";
      readonly errorTag: string;
    };

export function deliverySuccess(outcome: TurnOutcome): DeliveryTruth {
  return outcome.transport === "desktop"
    ? { state: "confirmed-desktop", outcome }
    : {
        state: "confirmed-app-server",
        outcome,
        transport: outcome.transport,
      };
}

export function deliveryFailure(error: DeliveryError): DeliveryTruth {
  if (error._tag === "DesktopVisibilityUnconfirmed") {
    return {
      state: "confirmed-app-server",
      outcome: null,
      transport: error.submittedTransport,
    };
  }
  if (error._tag === "NoTransportAvailable") {
    return { state: "unavailable", errorTag: error._tag };
  }
  const result = disposition(error);
  if (result.submission === "submitted" && "transport" in error) {
    const transport = error.transport;
    if (transport === "desktop") {
      return {
        state: "confirmed-desktop",
        outcome: null,
      };
    }
    if (typeof transport === "string") {
      return {
        state: "confirmed-app-server",
        outcome: null,
        transport,
      };
    }
  }
  if (result.submission === "unknown" || result.submission === "submitted") {
    return { state: "ambiguous", errorTag: error._tag };
  }
  return result.recovery === "try-next"
    ? { state: "unavailable", errorTag: error._tag }
    : { state: "rejected", errorTag: error._tag };
}

export const capacityUnavailable: DeliveryTruth = {
  state: "unavailable",
  errorTag: "DeliveryCapacityExceeded",
};
