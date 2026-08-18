import { Data } from "effect";
export type CanonicalQueryFailureCode =
  | "not-written"
  | "write-ambiguous"
  | "request-rejected"
  | "disconnected"
  | "timeout"
  | "malformed"
  | "pagination"
  | "history-incomplete";

export class CanonicalQueryFailure extends Data.TaggedError(
  "CanonicalQueryFailure",
)<{
  readonly code: CanonicalQueryFailureCode;
}> {}

export type CanonicalQueryError = CanonicalQueryFailure;

export class CanonicalPlaneUnavailable extends Data.TaggedError(
  "CanonicalPlaneUnavailable",
)<{
  readonly reason:
    | "no-local-app-server"
    | "scope-unavailable"
    | "scope-mismatch";
  readonly detail: string;
}> {}

export type MutationOperation =
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt";

export type CanonicalMutationResult<A> =
  | {
      readonly truth: "confirmed-app-server";
      readonly operation: MutationOperation;
      readonly value: A;
    }
  | {
      readonly truth: "rejected";
      readonly operation: MutationOperation;
      readonly rpcCode: number;
    }
  | {
      readonly truth: "unavailable";
      readonly operation: MutationOperation;
      readonly reason: "pre-submit-failure";
    }
  | {
      readonly truth: "ambiguous";
      readonly operation: MutationOperation;
      readonly reason:
        | "write-error"
        | "disconnected"
        | "timeout"
        | "malformed";
    };
