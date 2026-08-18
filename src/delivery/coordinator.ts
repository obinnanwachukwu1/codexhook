import { Cause, Duration, Effect, Layer, Option } from "effect";
import {
  type DeliveryAttempt,
  type DeliveryOutcome,
  type DeliveryRequest,
  LocalDeliveryCoordinator,
  PHASE_ONE_DELIVERY_POLICY,
  mayFallback,
} from "../contracts/delivery.js";
import { Desktop } from "../contracts/desktop.js";
import { sanitizeDiagnostic } from "../contracts/diagnostics.js";
import { LocalCodex } from "../contracts/local-codex.js";
import type {
  DeliveryRoute,
  RouteSubmissionOutcome,
} from "../contracts/submission.js";
import type { DeliveryId, ThreadId } from "../types.js";
import {
  TaskGatePool,
  attempt,
  confirmed,
  reconcileDelivery,
  remainingWait,
  routeResult,
  timeoutBeforeWrite,
  unavailable,
  unexpected,
  type PendingReconciliation,
  type RoutingResult,
} from "./coordinator-support.js";
import {
  awaitActivityCycle,
  awaitIdle,
  inspectIdle,
} from "./coordinator-queue.js";

interface RetryIdle {
  readonly _tag: "RetryIdle";
  /** Desktop observed activity that the canonical stream must see complete. */
  readonly requireActivity: boolean;
}

type DesktopDecision = RouteSubmissionOutcome<"desktop"> | RetryIdle;
type GatedResult = RoutingResult | RetryIdle;

export const LocalDeliveryCoordinatorLive = Layer.effect(
  LocalDeliveryCoordinator,
  Effect.gen(function* () {
    const desktop = yield* Desktop;
    const local = yield* LocalCodex;
    const gates = new TaskGatePool();
    // An unresolved Desktop write keeps later commands on the canonical plane.
    // A process restart is the conservative recovery boundary until Desktop
    // exposes an independently verified attachment-health transition.
    const desktopBreakers = new Map<ThreadId, DeliveryId>();
    const unfollowable = (
      request: DeliveryRequest,
      reason: "pre-submit-failure" | "task-busy",
    ) => unavailable(request, "desktop", reason, sanitizeDiagnostic({
      code: "desktop-not-following",
      stage: "follow-desktop",
      route: "desktop",
    })) as RouteSubmissionOutcome<"desktop">;

    const submitDesktop = (
      request: DeliveryRequest,
      deadline: number,
    ): Effect.Effect<DesktopDecision> => {
      let submitted = false;
      const operation = Effect.gen(function* () {
        if (desktopBreakers.has(request.task.threadId)) {
          return unavailable(
            request,
            "desktop",
            "unavailable",
            sanitizeDiagnostic({
              code: "desktop-unavailable",
              stage: "probe-desktop",
              route: "desktop",
            }),
          ) as RouteSubmissionOutcome<"desktop">;
        }
        const timedAvailability = yield* desktop.availability.pipe(
          Effect.timeoutOption(remainingWait(request, deadline)),
        );
        if (Option.isNone(timedAvailability)) {
          return timeoutBeforeWrite(
            request,
            "desktop",
            "probe-desktop",
          ) as RouteSubmissionOutcome<"desktop">;
        }
        const availability = timedAvailability.value;
        if (availability.status !== "available") {
          return unavailable(
            request,
            "desktop",
            availability.status === "incompatible"
              ? "incompatible"
              : "unavailable",
            availability.diagnostic,
          ) as RouteSubmissionOutcome<"desktop">;
        }
        return yield* Effect.scoped(Effect.gen(function* () {
          const connected = yield* desktop.connect.pipe(
            Effect.timeoutOption(remainingWait(request, deadline)),
          );
          if (Option.isNone(connected)) {
            return timeoutBeforeWrite(
              request,
              "desktop",
              "connect-desktop",
            ) as RouteSubmissionOutcome<"desktop">;
          }
          const followed = yield* connected.value.follow(request.task).pipe(
            Effect.timeoutOption(remainingWait(request, deadline)),
          );
          if (Option.isNone(followed)) {
            return timeoutBeforeWrite(
              request,
              "desktop",
              "follow-desktop",
            ) as RouteSubmissionOutcome<"desktop">;
          }
          if (
            request.mode === "steer" &&
            followed.value.activity === "multiple-active"
          ) return unfollowable(request, "task-busy");
          if (request.mode === "steer" && followed.value.activity === "idle") {
            return unfollowable(request, "pre-submit-failure");
          }
          if (request.mode === "queue" && followed.value.activity !== "idle") {
            return { _tag: "RetryIdle", requireActivity: true } as const;
          }
          if (Date.now() >= deadline) {
            return timeoutBeforeWrite(
              request,
              "desktop",
              "submit-desktop",
            ) as RouteSubmissionOutcome<"desktop">;
          }
          submitted = true;
          return yield* connected.value.submit(request.mode === "queue"
            ? {
                task: request.task,
                deliveryId: request.deliveryId,
                message: request.message,
                mode: "queue",
                replyTimeout: remainingWait(request, deadline),
              }
            : {
                task: request.task,
                deliveryId: request.deliveryId,
                message: request.message,
                mode: "steer",
                expectedTurnId: followed.value.activeTurnId!,
                replyTimeout: remainingWait(request, deadline),
              });
        }));
      });
      return operation.pipe(
        Effect.catchAll((failure) => Effect.succeed(unavailable(
          request,
          "desktop",
          failure.diagnostic.code === "desktop-incompatible"
            ? "incompatible"
            : failure.diagnostic.code === "desktop-unavailable"
              ? "unavailable"
              : "pre-submit-failure",
          failure.diagnostic,
        ) as RouteSubmissionOutcome<"desktop">)),
        Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
          ? Effect.failCause(cause)
          : Effect.succeed(
            unexpected(request, "desktop", submitted) as
              RouteSubmissionOutcome<"desktop">,
          )),
      );
    };

    const submitLocal = (
      request: DeliveryRequest,
      deadline: number,
    ): Effect.Effect<RouteSubmissionOutcome<"app-server">> => {
      let submitted = false;
      const operation = Effect.gen(function* () {
        const timedAvailability = yield* local.availability.pipe(
          Effect.timeoutOption(remainingWait(request, deadline)),
        );
        if (Option.isNone(timedAvailability)) {
          return timeoutBeforeWrite(
            request,
            "app-server",
            "check-app-server",
          ) as RouteSubmissionOutcome<"app-server">;
        }
        const availability = timedAvailability.value;
        if (availability.status !== "available") {
          return unavailable(
            request,
            "app-server",
            availability.status === "incompatible"
              ? "incompatible"
              : "unavailable",
            availability.diagnostic,
          ) as RouteSubmissionOutcome<"app-server">;
        }
        if (Date.now() >= deadline) {
          return timeoutBeforeWrite(
            request,
            "app-server",
            "submit-app-server",
          ) as RouteSubmissionOutcome<"app-server">;
        }
        submitted = true;
        return yield* local.submit({
          task: request.task,
          deliveryId: request.deliveryId,
          message: request.message,
          mode: request.mode,
          replyTimeout: remainingWait(request, deadline),
        });
      });
      return operation.pipe(Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.failCause(cause)
          : Effect.succeed(
            unexpected(request, "app-server", submitted) as
              RouteSubmissionOutcome<"app-server">,
          )
      ));
    };

    const route = (
      request: DeliveryRequest,
      deadline: number,
    ): Effect.Effect<GatedResult> => Effect.gen(function* () {
      const desktopStarted = Date.now();
      const desktopOutcome = yield* submitDesktop(request, deadline);
      if (desktopOutcome._tag === "RetryIdle") return desktopOutcome;
      if (
        request.mode === "queue" &&
        desktopOutcome._tag === "NotSubmitted" &&
        desktopOutcome.reason === "task-busy"
      ) return { _tag: "RetryIdle", requireActivity: true } as const;
      const desktopAttempt = attempt(desktopOutcome, desktopStarted);
      if (desktopOutcome._tag === "Ambiguous") {
        desktopBreakers.set(request.task.threadId, request.deliveryId);
      }
      if (!mayFallback(desktopOutcome)) {
        return routeResult(request, desktopOutcome, [desktopAttempt]);
      }
      if (Date.now() >= deadline) {
        return routeResult(request, desktopOutcome, [desktopAttempt]);
      }
      const localStarted = Date.now();
      const localOutcome = yield* submitLocal(request, deadline);
      return routeResult(request, localOutcome, [
        desktopAttempt,
        attempt(localOutcome, localStarted),
      ]);
    });

    const reconcile = (
      request: DeliveryRequest,
      deadline: number,
      pending: PendingReconciliation,
    ): Effect.Effect<DeliveryOutcome> => Effect.gen(function* () {
      const startedAt = Date.now();
      const matched = yield* reconcileDelivery(
        local,
        request,
        deadline,
        pending.route,
      );
      const reconciliationAttempt: DeliveryAttempt = {
        route: pending.route,
        stage: "reconcile-app-server",
        outcome: matched.turnId == null ? "Ambiguous" : "Confirmed",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        ...(matched.turnId == null ? { diagnostic: matched.diagnostic } : {}),
      };
      const attempts = [...pending.attempts, reconciliationAttempt];
      if (
        matched.turnId != null &&
        desktopBreakers.get(request.task.threadId) === request.deliveryId
      ) desktopBreakers.delete(request.task.threadId);
      return matched.turnId == null
        ? {
            _tag: "Ambiguous",
            task: request.task,
            deliveryId: request.deliveryId,
            route: pending.route,
            attempts,
            diagnostic: matched.diagnostic,
          }
        : confirmed(
            pending.route,
            request,
            matched.turnId,
            request.mode === "queue" ? "start" : "steer",
            attempts,
          );
    });

    const idleUnavailable = (
      request: DeliveryRequest,
      diagnostic: ReturnType<typeof sanitizeDiagnostic>,
    ): DeliveryOutcome => ({
      _tag: "Unavailable",
      task: request.task,
      deliveryId: request.deliveryId,
      attempts: [{
        route: "app-server",
        stage: "await-turn",
        outcome: "NotSubmitted",
        elapsedMs: 0,
        diagnostic,
      }],
      diagnostic,
    });

    const finish = (
      request: DeliveryRequest,
      deadline: number,
      result: RoutingResult,
    ): Effect.Effect<DeliveryOutcome> =>
      result._tag === "PendingReconciliation"
        ? reconcile(request, deadline, result)
        : Effect.succeed(result);

    const queueDelivery = (
      request: DeliveryRequest,
      deadline: number,
    ): Effect.Effect<DeliveryOutcome> => Effect.suspend(() => {
      if (Date.now() >= deadline) {
        return Effect.succeed(idleUnavailable(request, sanitizeDiagnostic({
          code: "timeout",
          stage: "await-turn",
          route: "app-server",
        })));
      }
      return awaitIdle(local, request, deadline).pipe(
        Effect.flatMap((idleFailure) => {
          if (idleFailure != null) {
            return Effect.succeed(idleUnavailable(request, idleFailure));
          }
          return gates.run(request.task.threadId, Effect.gen(function* () {
            const inspection = yield* inspectIdle(local, request, deadline);
            if (inspection._tag === "Failed") {
              return idleUnavailable(request, inspection.diagnostic);
            }
            if (inspection._tag === "Active") {
              return { _tag: "RetryIdle", requireActivity: false } as const;
            }
            return yield* route(request, deadline);
          }));
        }),
        Effect.flatMap((result) => {
          if (result._tag !== "RetryIdle") {
            return finish(request, deadline, result);
          }
          if (!result.requireActivity) return queueDelivery(request, deadline);
          return awaitActivityCycle(local, request, deadline).pipe(
            Effect.flatMap((failure) => failure == null
              ? queueDelivery(request, deadline)
              : Effect.succeed(idleUnavailable(request, failure))),
          );
        }),
      );
    });

    return LocalDeliveryCoordinator.of({
      policy: PHASE_ONE_DELIVERY_POLICY,
      deliver: (request) => {
        const deadline = Date.now() + Math.max(
          1,
          Duration.toMillis(request.turnTimeout),
        );
        if (request.mode === "queue") {
          return queueDelivery(request, deadline);
        }
        return gates.run(
            request.task.threadId,
            route(request, deadline),
          ).pipe(Effect.flatMap((result) => result._tag === "RetryIdle"
            ? Effect.succeed(idleUnavailable(request, sanitizeDiagnostic({
                code: "internal",
                stage: "await-turn",
                route: "app-server",
              })))
            : finish(request, deadline, result)));
      },
    });
  }),
);
