import { Data } from "effect";
export type CanonicalQueryFailureCode =
  | "request-ambiguous"
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

export type CanonicalPlaneUnavailableCause =
  | "desktop-plane"
  | "remote-code-mode-host"
  | "non-local-socket"
  | "incomplete-metadata"
  | "platform-mismatch"
  | "store-mismatch"
  | "no-candidate"
  | "candidates-rejected";

export class CanonicalPlaneUnavailable extends Data.TaggedError(
  "CanonicalPlaneUnavailable",
)<{
  readonly reason:
    | "no-local-app-server"
    | "scope-unavailable"
    | "scope-mismatch";
  readonly cause: CanonicalPlaneUnavailableCause;
  readonly rejectedCandidates: ReadonlyArray<"app-bundled" | "cli" | "daemon">;
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
        | "malformed"
        | "interrupted"
        | "defect";
    };
