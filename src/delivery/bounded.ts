import { Effect } from "effect";
import type { TurnRequest } from "../types.js";
import type {
  DeliveryEvidence,
  DeliveryReceipt,
  RoutingDiagnostic,
} from "./routing-contracts.js";

export const TIMEOUT: RoutingDiagnostic = { code: "timeout" };
export const INTERNAL: RoutingDiagnostic = { code: "internal" };

export function boundedEvidence(
  effect: Effect.Effect<DeliveryEvidence>,
  timeout: TurnRequest["turnTimeout"],
): Effect.Effect<DeliveryEvidence> {
  return effect.pipe(
    // A stuck native transport must not retain the task gate after timeout.
    Effect.disconnect,
    Effect.catchAllDefect(() => Effect.succeed({
      _tag: "Unresolved" as const,
      diagnostic: INTERNAL,
    })),
    Effect.timeoutTo({
      duration: timeout,
      onTimeout: () => ({ _tag: "Unresolved", diagnostic: TIMEOUT }),
      onSuccess: (evidence) => evidence,
    }),
  );
}

export function boundedReceipt(
  effect: Effect.Effect<DeliveryReceipt>,
  timeout: TurnRequest["turnTimeout"],
): Effect.Effect<DeliveryReceipt> {
  return effect.pipe(
    Effect.disconnect,
    Effect.catchAllDefect(() => Effect.succeed({
      _tag: "Uncertain" as const,
      diagnostic: INTERNAL,
    })),
    Effect.timeoutTo({
      duration: timeout,
      onTimeout: () => ({ _tag: "Uncertain", diagnostic: TIMEOUT }),
      onSuccess: (receipt) => receipt,
    }),
  );
}
