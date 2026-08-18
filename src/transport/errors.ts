import { Data } from "effect";
import type { TransportId } from "../types.js";

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
    | "pre-submit-failure"
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
