import { Duration, Effect } from "effect";
import type { TurnRequest } from "../types.js";
import type {
  DeliveryEvidence,
  DeliveryReceipt,
  DesktopRouteState,
  RoutingDiagnostic,
} from "./routing-contracts.js";

export const TIMEOUT: RoutingDiagnostic = { code: "timeout" };
export const INTERNAL: RoutingDiagnostic = { code: "internal" };
const ROUTE_STATE_TIMEOUT = Duration.seconds(30);

type BoundedRouteState = DesktopRouteState | { readonly _tag: "TimedOut" };

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

export function boundedRouteState(
  effect: Effect.Effect<DesktopRouteState>,
  timeout: TurnRequest["turnTimeout"],
): Effect.Effect<BoundedRouteState> {
  return effect.pipe(
    Effect.disconnect,
    Effect.catchAllDefect(() =>
      Effect.succeed({ _tag: "Unhealthy" as const })),
    Effect.timeoutTo({
      duration: Duration.min(Duration.decode(timeout), ROUTE_STATE_TIMEOUT),
      onTimeout: () => ({ _tag: "TimedOut" }),
      onSuccess: (state) => state,
    }),
  );
}
