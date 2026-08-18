import { Data } from "effect";
import type {
  RpcDisconnected,
  RpcErrorReply,
  RpcMalformed,
  RpcNotWritten,
  RpcTimeout,
  RpcWriteAmbiguous,
} from "../transport/rpc.js";

export type CanonicalQueryError =
  | RpcNotWritten
  | RpcWriteAmbiguous
  | RpcErrorReply
  | RpcDisconnected
  | RpcTimeout
  | RpcMalformed
  | CanonicalPaginationError;

export class CanonicalPaginationError extends Data.TaggedError(
  "CanonicalPaginationError",
)<{
  readonly method: "thread/list" | "thread/turns/list";
  readonly detail: string;
}> {}

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
      readonly code: number;
      readonly message: string;
    }
  | {
      readonly truth: "unavailable";
      readonly operation: MutationOperation;
      readonly detail: string;
    }
  | {
      readonly truth: "ambiguous";
      readonly operation: MutationOperation;
      readonly detail: string;
    };
