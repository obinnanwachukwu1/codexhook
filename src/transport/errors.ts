import { Data, Option } from "effect";
import type {
  DeliveryId,
  ThreadId,
  TransportId,
  TurnId,
} from "../types.js";
import {
  truthForTransport,
  type DeliveryTruth,
} from "../diagnostics/truth.js";

export class TransportUnavailable extends Data.TaggedError(
  "TransportUnavailable",
)<{
  readonly transport: TransportId;
  readonly reason:
    | "not-installed"
    | "spawn-failed"
    | "connect-failed"
    | "handshake-timeout"
    | "not-running"
    | "exited";
  readonly detail: string;
}> {}

export class TransportIncompatible extends Data.TaggedError(
  "TransportIncompatible",
)<{
  readonly transport: TransportId;
  readonly stage:
    | "initialize"
    | "capabilities"
    | "method-missing"
    | "malformed";
  readonly detail: string;
}> {}

export class ThreadUnavailable extends Data.TaggedError("ThreadUnavailable")<{
  readonly transport: TransportId;
  readonly threadId: ThreadId;
  readonly detail: string;
}> {}

export class ThreadBusy extends Data.TaggedError("ThreadBusy")<{
  readonly transport: TransportId;
  readonly threadId: ThreadId;
  readonly heldTurnId: Option.Option<TurnId>;
  readonly waitedMillis: number;
}> {}

export class SubmitRejected extends Data.TaggedError("SubmitRejected")<{
  readonly transport: TransportId;
  readonly method: "turn/start" | "turn/steer";
  readonly code: number;
  readonly message: string;
}> {}

export class SubmitAmbiguous extends Data.TaggedError("SubmitAmbiguous")<{
  readonly transport: TransportId;
  readonly method: "turn/start" | "turn/steer";
  readonly threadId: ThreadId;
  readonly deliveryId: DeliveryId;
  readonly cause: "disconnected" | "timeout" | "malformed" | "write-error";
}> {}

export class TurnAbandoned extends Data.TaggedError("TurnAbandoned")<{
  readonly transport: TransportId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly detail: string;
}> {}

export class TurnFailed extends Data.TaggedError("TurnFailed")<{
  readonly transport: TransportId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly status: "failed" | "interrupted";
  readonly message: Option.Option<string>;
}> {}

export class TurnTimeout extends Data.TaggedError("TurnTimeout")<{
  readonly transport: TransportId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly waitedMillis: number;
}> {}

export class DesktopVisibilityUnconfirmed extends Data.TaggedError(
  "DesktopVisibilityUnconfirmed",
)<{
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly submittedTransport: Exclude<TransportId, "desktop">;
  readonly detail: string;
}> {}

export type TransportError =
  | TransportUnavailable
  | TransportIncompatible
  | ThreadUnavailable
  | ThreadBusy
  | SubmitRejected
  | SubmitAmbiguous
  | TurnAbandoned
  | TurnFailed
  | TurnTimeout
  | DesktopVisibilityUnconfirmed;

export class NoTransportAvailable extends Data.TaggedError(
  "NoTransportAvailable",
)<{
  readonly attempts: ReadonlyArray<{
    readonly transport: TransportId;
    readonly stage: string;
    readonly errorTag: string;
    readonly detail: string;
    readonly elapsedMs: number;
  }>;
}> {}

export type DeliveryError = TransportError | NoTransportAvailable;

export type Disposition =
  | {
      readonly recovery: "try-next";
      readonly submission: "not-submitted";
    }
  | {
      readonly recovery: "stop";
      readonly submission: "not-submitted" | "unknown" | "submitted";
    };

export const DISPOSITIONS = {
  TransportUnavailable: {
    recovery: "try-next",
    submission: "not-submitted",
  },
  TransportIncompatible: {
    recovery: "try-next",
    submission: "not-submitted",
  },
  ThreadUnavailable: { recovery: "stop", submission: "not-submitted" },
  ThreadBusy: { recovery: "stop", submission: "not-submitted" },
  SubmitRejected: { recovery: "stop", submission: "not-submitted" },
  SubmitAmbiguous: { recovery: "stop", submission: "unknown" },
  TurnAbandoned: { recovery: "stop", submission: "unknown" },
  TurnFailed: { recovery: "stop", submission: "submitted" },
  TurnTimeout: { recovery: "stop", submission: "submitted" },
  DesktopVisibilityUnconfirmed: {
    recovery: "stop",
    submission: "submitted",
  },
} as const satisfies {
  readonly [K in TransportError["_tag"]]: Disposition;
};

export function disposition(error: TransportError): Disposition {
  return DISPOSITIONS[error._tag];
}

export function deliveryTruth(error: DeliveryError): DeliveryTruth {
  if (error._tag === "NoTransportAvailable") return "unavailable";
  switch (disposition(error).submission) {
    case "not-submitted":
      return error._tag === "SubmitRejected" ? "rejected" : "unavailable";
    case "unknown":
      return "ambiguous";
    case "submitted":
      return truthForTransport(errorTransport(error));
  }
}

export function errorTransport(error: NoTransportAvailable): undefined;
export function errorTransport(error: TransportError): TransportId;
export function errorTransport(error: DeliveryError): TransportId | undefined;
export function errorTransport(
  error: DeliveryError,
): TransportId | undefined {
  switch (error._tag) {
    case "NoTransportAvailable":
      return undefined;
    case "DesktopVisibilityUnconfirmed":
      return error.submittedTransport;
    case "TransportUnavailable":
    case "TransportIncompatible":
    case "ThreadUnavailable":
    case "ThreadBusy":
    case "SubmitRejected":
    case "SubmitAmbiguous":
    case "TurnAbandoned":
    case "TurnFailed":
    case "TurnTimeout":
      return error.transport;
  }
}

type TryNextTag = {
  [K in TransportError["_tag"]]: (typeof DISPOSITIONS)[K]["recovery"] extends "try-next"
    ? K
    : never;
}[TransportError["_tag"]];

export type TryNextError = Extract<
  TransportError,
  { readonly _tag: TryNextTag }
>;

const TRY_NEXT = new Set<string>(
  Object.entries(DISPOSITIONS)
    .filter(([, value]) => value.recovery === "try-next")
    .map(([tag]) => tag),
);

export function isTryNext(error: DeliveryError): error is TryNextError {
  return TRY_NEXT.has(error._tag);
}
