import { Cause, Effect, Exit, Option, type Duration, type Schema } from "effect";
import type { AppServerPeer } from "../transport/rpc.js";
import type {
  CanonicalMutationResult,
  MutationOperation,
} from "./errors.js";

function ambiguousReason(
  error: { readonly _tag: string },
): "disconnected" | "timeout" | "malformed" {
  return error._tag === "RpcDisconnected"
    ? "disconnected"
    : error._tag === "RpcTimeout"
      ? "timeout"
      : "malformed";
}

export function mutate<A, I>(
  peer: AppServerPeer,
  operation: MutationOperation,
  params: unknown,
  schema: Schema.Schema<A, I>,
  timeout: Duration.DurationInput,
): Effect.Effect<CanonicalMutationResult<A>> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.exit(restore(
        peer.prepare(operation, params),
      ));
      if (Exit.isFailure(prepared)) {
        return {
          truth: "unavailable",
          operation,
          reason: "pre-submit-failure",
        };
      }
      const submitted = yield* Effect.exit(peer.submit(prepared.value));
      if (Exit.isFailure(submitted)) {
        const typed = Cause.failureOption(submitted.cause);
        return Option.isSome(typed) && typed.value._tag === "RpcNotWritten"
          ? {
            truth: "unavailable",
            operation,
            reason: "pre-submit-failure",
          }
          : {
            truth: "ambiguous",
            operation,
            reason: "write-error",
          };
      }
      const replied = yield* Effect.exit(restore(
        peer.reply(prepared.value, schema, timeout),
      ));
      if (Exit.isSuccess(replied)) {
        return {
          truth: "confirmed-app-server",
          operation,
          value: replied.value,
        };
      }
      const typed = Cause.failureOption(replied.cause);
      if (Option.isSome(typed) && typed.value._tag === "RpcErrorReply") {
        return {
          truth: "rejected",
          operation,
          rpcCode: typed.value.code,
        };
      }
      if (Option.isSome(typed)) {
        return {
          truth: "ambiguous",
          operation,
          reason: ambiguousReason(typed.value),
        };
      }
      return {
        truth: "ambiguous",
        operation,
        reason: Cause.isInterruptedOnly(replied.cause)
          ? "interrupted"
          : "defect",
      };
    })
  );
}
