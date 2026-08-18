import { Duration, Effect, Option, Stream } from "effect";
import type {
  DeliveryAttempt,
  DeliveryOutcome,
  DeliveryRequest,
} from "../contracts/delivery.js";
import {
  sanitizeDiagnostic,
  type SanitizedDiagnostic,
} from "../contracts/diagnostics.js";
import type {
  LocalCodexService,
  LocalTaskEvent,
} from "../contracts/local-codex.js";
import type {
  DeliveryRoute,
  RouteSubmissionOutcome,
} from "../contracts/submission.js";
import type { ThreadId, TurnId } from "../types.js";

export interface PendingReconciliation {
  readonly _tag: "PendingReconciliation";
  readonly route: DeliveryRoute;
  readonly outcome: Extract<RouteSubmissionOutcome, { readonly _tag: "Ambiguous" }>;
  readonly attempts: ReadonlyArray<DeliveryAttempt>;
}

export type RoutingResult = DeliveryOutcome | PendingReconciliation;

export function unavailable(
  request: DeliveryRequest,
  route: DeliveryRoute,
  reason: "unavailable" | "incompatible" | "pre-submit-failure",
  diagnostic: SanitizedDiagnostic,
): RouteSubmissionOutcome {
  return {
    _tag: "NotSubmitted",
    route,
    deliveryId: request.deliveryId,
    reason,
    diagnostic,
  };
}

export function unexpected(
  request: DeliveryRequest,
  route: DeliveryRoute,
  submitted: boolean,
): RouteSubmissionOutcome {
  const diagnostic = sanitizeDiagnostic({
    code: submitted ? "write-ambiguous" : "internal",
    stage: route === "desktop" ? "submit-desktop" : "submit-app-server",
    route,
  });
  return submitted
    ? {
        _tag: "Ambiguous",
        route,
        deliveryId: request.deliveryId,
        diagnostic,
      }
    : unavailable(request, route, "pre-submit-failure", diagnostic);
}

export function timeoutBeforeWrite(
  request: DeliveryRequest,
  route: DeliveryRoute,
  stage: "probe-desktop" | "connect-desktop" | "follow-desktop" |
    "check-app-server" | "submit-desktop" | "submit-app-server",
): RouteSubmissionOutcome {
  return unavailable(request, route, "unavailable", sanitizeDiagnostic({
    code: "timeout",
    stage,
    route,
  }));
}

export class TaskGatePool {
  readonly #gates = new Map<ThreadId, {
    readonly semaphore: Effect.Semaphore;
    users: number;
  }>();

  run<A>(threadId: ThreadId, effect: Effect.Effect<A>): Effect.Effect<A> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        let gate = this.#gates.get(threadId);
        if (gate == null) {
          gate = { semaphore: Effect.unsafeMakeSemaphore(1), users: 0 };
          this.#gates.set(threadId, gate);
        }
        gate.users += 1;
        return gate;
      }),
      (gate) => gate.semaphore.withPermits(1)(effect),
      (gate) => Effect.sync(() => {
        gate.users -= 1;
        if (gate.users === 0) this.#gates.delete(threadId);
      }),
    );
  }
}

export function remainingWait(
  request: DeliveryRequest,
  deadline: number,
): Duration.Duration {
  return Duration.millis(Math.min(
    Math.max(1, deadline - Date.now()),
    Math.max(1, Duration.toMillis(request.idleTimeout)),
  ));
}

function stageFor(outcome: RouteSubmissionOutcome): DeliveryAttempt["stage"] {
  return (outcome._tag === "Confirmed" ? undefined : outcome.diagnostic.stage) ??
    (outcome.route === "desktop" ? "submit-desktop" : "submit-app-server");
}

export function attempt(
  outcome: RouteSubmissionOutcome,
  startedAt: number,
  stage = stageFor(outcome),
): DeliveryAttempt {
  return {
    route: outcome.route,
    stage,
    outcome: outcome._tag,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(outcome._tag === "Confirmed" ? {} : { diagnostic: outcome.diagnostic }),
  };
}

export function confirmed(
  route: DeliveryRoute,
  request: DeliveryRequest,
  turnId: TurnId,
  operation: "start" | "steer",
  attempts: ReadonlyArray<DeliveryAttempt>,
): DeliveryOutcome {
  return {
    _tag: route === "desktop" ? "ConfirmedDesktop" : "ConfirmedAppServer",
    task: request.task,
    deliveryId: request.deliveryId,
    turnId,
    operation,
    attempts,
  };
}

export function routeResult(
  request: DeliveryRequest,
  outcome: RouteSubmissionOutcome,
  attempts: ReadonlyArray<DeliveryAttempt>,
): RoutingResult {
  if (outcome._tag === "Confirmed") {
    return confirmed(
      outcome.route,
      request,
      outcome.turnId,
      outcome.operation,
      attempts,
    );
  }
  if (outcome._tag === "Ambiguous") {
    return {
      _tag: "PendingReconciliation",
      route: outcome.route,
      outcome,
      attempts,
    };
  }
  if (outcome._tag === "Rejected") {
    return {
      _tag: "Rejected",
      task: request.task,
      deliveryId: request.deliveryId,
      route: outcome.route,
      attempts,
      diagnostic: outcome.diagnostic,
    };
  }
  return {
    _tag: "Unavailable",
    task: request.task,
    deliveryId: request.deliveryId,
    attempts,
    diagnostic: outcome.diagnostic,
  };
}

function timeoutDiagnostic(
  route: DeliveryRoute,
  stage: "await-turn" | "reconcile-app-server",
): SanitizedDiagnostic {
  return sanitizeDiagnostic({ code: "timeout", stage, route });
}

export function awaitIdle(
  local: LocalCodexService,
  request: DeliveryRequest,
  deadline: number,
): Effect.Effect<SanitizedDiagnostic | null> {
  const active = new Set<TurnId>();
  let initialized = false;
  const ready = local.events(request.task).pipe(
    Stream.filterMap((event) => {
      if (event.type === "task-removed") {
        return Option.some(sanitizeDiagnostic({
          code: "task-not-found",
          stage: "await-turn",
          route: "app-server",
        }));
      }
      if (event.type === "snapshot") {
        initialized = true;
        active.clear();
        for (const turn of event.history.turns) {
          if (turn.status === "in-progress") active.add(turn.id);
        }
      } else if (initialized) {
        if (event.turn.status === "in-progress") active.add(event.turn.id);
        else active.delete(event.turn.id);
      }
      return initialized && active.size === 0
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
    Effect.catchAllCause(() => Effect.succeed(sanitizeDiagnostic({
      code: "internal",
      stage: "await-turn",
      route: "app-server",
    }))),
  );
  return ready;
}

export type IdleInspection =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Active" }
  | { readonly _tag: "Failed"; readonly diagnostic: SanitizedDiagnostic };

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
          return {
            _tag: "Failed",
            diagnostic: timeoutDiagnostic("app-server", "await-turn"),
          };
        }
        const event = timed.value.value;
        if (event.type === "task-removed") {
          return {
            _tag: "Failed",
            diagnostic: sanitizeDiagnostic({
              code: "task-not-found",
              stage: "await-turn",
              route: "app-server",
            }),
          };
        }
        if (event.type !== "snapshot") {
          return {
            _tag: "Failed",
            diagnostic: sanitizeDiagnostic({
              code: "internal",
              stage: "await-turn",
              route: "app-server",
            }),
          };
        }
        return event.history.turns.some((turn) =>
            turn.status === "in-progress"
          )
          ? { _tag: "Active" }
          : { _tag: "Idle" };
      },
    }),
    Effect.catchAllCause(() => Effect.succeed({
      _tag: "Failed" as const,
      diagnostic: sanitizeDiagnostic({
        code: "internal",
        stage: "await-turn",
        route: "app-server",
      }),
    })),
  );
}

function eventTurn(
  event: LocalTaskEvent,
  deliveryId: DeliveryRequest["deliveryId"],
): TurnId | null {
  const turns = event.type === "snapshot"
    ? event.history.turns
    : event.type === "turn-changed"
      ? [event.turn]
      : [];
  return turns.find((turn) => turn.deliveryIds.includes(deliveryId))?.id ?? null;
}

export function reconcileDelivery(
  local: LocalCodexService,
  request: DeliveryRequest,
  deadline: number,
  route: DeliveryRoute,
): Effect.Effect<{
  readonly turnId: TurnId | null;
  readonly diagnostic: SanitizedDiagnostic;
}> {
  return local.events(request.task).pipe(
    Stream.filterMap((event) => Option.fromNullable(
      eventTurn(event, request.deliveryId),
    )),
    Stream.runHead,
    Effect.timeoutOption(remainingWait(request, deadline)),
    Effect.match({
      onFailure: (failure) => ({
        turnId: null,
        diagnostic: failure.diagnostic,
      }),
      onSuccess: (timed) => ({
        turnId: Option.isSome(timed) && Option.isSome(timed.value)
          ? timed.value.value
          : null,
        diagnostic: timeoutDiagnostic(route, "reconcile-app-server"),
      }),
    }),
    Effect.catchAllCause(() => Effect.succeed({
      turnId: null,
      diagnostic: sanitizeDiagnostic({
        code: "internal",
        stage: "reconcile-app-server",
        route,
      }),
    })),
  );
}
