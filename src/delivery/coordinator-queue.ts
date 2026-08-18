import { Cause, Effect, Option, Stream } from "effect";
import type { DeliveryRequest } from "../contracts/delivery.js";
import {
  sanitizeDiagnostic,
  type SanitizedDiagnostic,
} from "../contracts/diagnostics.js";
import type {
  LocalCodexService,
  LocalTaskEvent,
} from "../contracts/local-codex.js";
import type { TurnId } from "../types.js";
import { remainingWait, timeoutDiagnostic } from "./coordinator-support.js";

export type IdleInspection =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Active" }
  | { readonly _tag: "Failed"; readonly diagnostic: SanitizedDiagnostic };

function taskRemoved(): SanitizedDiagnostic {
  return sanitizeDiagnostic({
    code: "task-not-found",
    stage: "await-turn",
    route: "app-server",
  });
}

function internal(): SanitizedDiagnostic {
  return sanitizeDiagnostic({
    code: "internal",
    stage: "await-turn",
    route: "app-server",
  });
}

function trackActive(active: Set<TurnId>, event: LocalTaskEvent): boolean {
  if (event.type === "snapshot") {
    active.clear();
    for (const turn of event.history.turns) {
      if (turn.status === "in-progress") active.add(turn.id);
    }
    return true;
  }
  if (event.type === "turn-changed") {
    if (event.turn.status === "in-progress") active.add(event.turn.id);
    else active.delete(event.turn.id);
  }
  return false;
}

function awaitState(
  local: LocalCodexService,
  request: DeliveryRequest,
  deadline: number,
  requireActivity: boolean,
): Effect.Effect<SanitizedDiagnostic | null> {
  const active = new Set<TurnId>();
  let initialized = false;
  let sawActivity = false;
  return local.events(request.task).pipe(
    Stream.filterMap((event) => {
      if (event.type === "task-removed") return Option.some(taskRemoved());
      initialized = trackActive(active, event) || initialized;
      if (initialized && active.size > 0) sawActivity = true;
      return initialized && active.size === 0 && (!requireActivity || sawActivity)
        ? Option.some(null)
        : Option.none();
    }),
    Stream.runHead,
    Effect.timeoutOption(remainingWait(request, deadline)),
    Effect.match({
      onFailure: (failure) => failure.diagnostic,
      onSuccess: (timed) => Option.isSome(timed) && Option.isSome(timed.value)
        ? timed.value.value
        : timeoutDiagnostic("app-server", "await-turn"),
    }),
    Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
      ? Effect.failCause(cause)
      : Effect.succeed(internal())),
  );
}

export function awaitIdle(
  local: LocalCodexService,
  request: DeliveryRequest,
  deadline: number,
): Effect.Effect<SanitizedDiagnostic | null> {
  return awaitState(local, request, deadline, false);
}

/** Waits for the active turn Desktop observed to appear and then become idle. */
export function awaitActivityCycle(
  local: LocalCodexService,
  request: DeliveryRequest,
  deadline: number,
): Effect.Effect<SanitizedDiagnostic | null> {
  return awaitState(local, request, deadline, true);
}

/** Snapshot-first, one-event recheck used only while the mutation gate is held. */
export function inspectIdle(
  local: LocalCodexService,
  request: DeliveryRequest,
  deadline: number,
): Effect.Effect<IdleInspection> {
  return local.events(request.task).pipe(
    Stream.runHead,
    Effect.timeoutOption(remainingWait(request, deadline)),
    Effect.match({
      onFailure: (failure): IdleInspection => ({
        _tag: "Failed",
        diagnostic: failure.diagnostic,
      }),
      onSuccess: (timed): IdleInspection => {
        if (Option.isNone(timed) || Option.isNone(timed.value)) {
          return { _tag: "Failed", diagnostic: timeoutDiagnostic(
            "app-server",
            "await-turn",
          ) };
        }
        const event = timed.value.value;
        if (event.type === "task-removed") {
          return { _tag: "Failed", diagnostic: taskRemoved() };
        }
        if (event.type !== "snapshot") {
          return { _tag: "Failed", diagnostic: internal() };
        }
        return event.history.turns.some((turn) =>
            turn.status === "in-progress"
          )
          ? { _tag: "Active" }
          : { _tag: "Idle" };
      },
    }),
    Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
      ? Effect.failCause(cause)
      : Effect.succeed({ _tag: "Failed", diagnostic: internal() } as const)),
  );
}
