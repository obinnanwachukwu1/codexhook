import {
  Context,
  Duration,
  Effect,
  HashMap,
  Layer,
  Option,
  Queue,
  SynchronizedRef,
} from "effect";
import { randomUUID } from "node:crypto";
import { Logger } from "../logger.js";
import {
  DeliveryId,
  type ThreadId,
  type TurnRequest,
  type WebhookRecord,
} from "../types.js";
import {
  disposition,
  type DeliveryError,
  type TransportError,
} from "../transport/errors.js";
import { CodexTransport } from "../transport/transport.js";
import { composeMessage } from "./compose.js";

const MAX_LANES = 1_000;
const LANE_CAPACITY = 100;
const STEER_CAPACITY = 100;

interface Job {
  readonly hookId: string;
  readonly request: TurnRequest;
}

interface Lane {
  readonly queue: Queue.Queue<Job>;
  readonly pending: number;
}

export interface DeliverySnapshot {
  readonly lanes: number;
  readonly depths: Readonly<Record<string, number>>;
  readonly steerDepth: number;
}

export interface DeliveryService {
  readonly submit: (
    hook: WebhookRecord,
    body: string,
  ) => Effect.Effect<Option.Option<DeliveryId>>;
  readonly snapshot: Effect.Effect<DeliverySnapshot>;
  readonly stopAccepting: Effect.Effect<void>;
  readonly drain: (
    timeout: Duration.DurationInput,
  ) => Effect.Effect<boolean>;
}

export class Delivery extends Context.Tag("codexhook/Delivery")<
  Delivery,
  DeliveryService
>() {}

function failureSubmission(error: DeliveryError): string {
  return error._tag === "NoTransportAvailable"
    ? "not-submitted"
    : disposition(error as TransportError).submission;
}

export function DeliveryLive(
  logger = new Logger(),
): Layer.Layer<Delivery, never, CodexTransport> {
  return Layer.scoped(
    Delivery,
    Effect.gen(function* () {
      const transport = yield* CodexTransport;
      const layerScope = yield* Effect.scope;
      const lanes = yield* SynchronizedRef.make(
        HashMap.empty<ThreadId, Lane>(),
      );
      const control = yield* SynchronizedRef.make({
        accepting: true,
        steerPending: 0,
      });

      const runJob = (job: Job): Effect.Effect<void> => {
        const startedAt = Date.now();
        logger.info("delivery_started", {
          deliveryId: job.request.deliveryId,
          hookId: job.hookId,
          threadId: job.request.threadId,
          mode: job.request.mode,
        });
        return transport.deliver(job.request).pipe(
          Effect.match({
            onSuccess: (outcome) => {
              logger.info("delivery_finished", {
                deliveryId: job.request.deliveryId,
                hookId: job.hookId,
                threadId: job.request.threadId,
                status: outcome._tag,
                transport: outcome.transport,
                durationMs: Date.now() - startedAt,
              });
            },
            onFailure: (error) => {
              logger.error("delivery_failed", {
                deliveryId: job.request.deliveryId,
                hookId: job.hookId,
                threadId: job.request.threadId,
                errorTag: error._tag,
                submission: failureSubmission(error),
                error: String(error),
                durationMs: Date.now() - startedAt,
              });
            },
          }),
        );
      };

      const worker = (
        threadId: ThreadId,
        queue: Queue.Queue<Job>,
      ): Effect.Effect<void> =>
        Queue.take(queue).pipe(
          Effect.flatMap(runJob),
          Effect.zipRight(
            SynchronizedRef.modifyEffect(lanes, (map) => {
              const current = HashMap.get(map, threadId);
              if (Option.isNone(current)) {
                return Effect.succeed([false, map] as const);
              }
              const pending = Math.max(0, current.value.pending - 1);
              return pending === 0
                ? Effect.succeed([
                    false,
                    HashMap.remove(map, threadId),
                  ] as const)
                : Effect.succeed([
                    true,
                    HashMap.set(map, threadId, {
                      ...current.value,
                      pending,
                    }),
                  ] as const);
            }),
          ),
          Effect.flatMap((continueWorking) =>
            continueWorking ? worker(threadId, queue) : Effect.void,
          ),
        );

      const offer = (
        threadId: ThreadId,
        job: Job,
      ): Effect.Effect<boolean> =>
        SynchronizedRef.modifyEffect(lanes, (map) => {
          const existing = HashMap.get(map, threadId);
          if (Option.isSome(existing)) {
            return Queue.offer(existing.value.queue, job).pipe(
              Effect.map((accepted) => [
                accepted,
                accepted
                  ? HashMap.set(map, threadId, {
                      ...existing.value,
                      pending: existing.value.pending + 1,
                    })
                  : map,
              ] as const),
            );
          }
          if (HashMap.size(map) >= MAX_LANES) {
            return Effect.succeed([false, map] as const);
          }
          return Effect.gen(function* () {
            const queue = yield* Queue.dropping<Job>(LANE_CAPACITY);
            const accepted = yield* Queue.offer(queue, job);
            if (!accepted) return [false, map] as const;
            yield* Effect.forkIn(worker(threadId, queue), layerScope);
            return [
              true,
              HashMap.set(map, threadId, { queue, pending: 1 }),
            ] as const;
          });
        });

      const reserveSteer = SynchronizedRef.modify(control, (state) => {
        if (!state.accepting || state.steerPending >= STEER_CAPACITY) {
          return [false, state] as const;
        }
        return [
          true,
          { ...state, steerPending: state.steerPending + 1 },
        ] as const;
      });

      const enqueue = (job: Job): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const state = yield* SynchronizedRef.get(control);
          if (!state.accepting) return false;
          if (job.request.mode !== "steer") {
            return yield* offer(job.request.threadId, job);
          }
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const accepted = yield* reserveSteer;
              if (!accepted) return false;
              yield* Effect.forkIn(
                runJob(job).pipe(
                  Effect.ensuring(
                    SynchronizedRef.update(control, (current) => ({
                      ...current,
                      steerPending: Math.max(0, current.steerPending - 1),
                    })),
                  ),
                ),
                layerScope,
              );
              return true;
            }),
          );
        });

      const submit: DeliveryService["submit"] = (hook, body) =>
        Effect.gen(function* () {
          const deliveryId = DeliveryId(randomUUID());
          const job: Job = {
            hookId: hook.id,
            request: {
              threadId: hook.threadId,
              deliveryId,
              message: composeMessage(hook, body),
              mode: hook.mode,
              idleTimeout: "30 minutes",
              turnTimeout: "30 minutes",
            },
          };
          const accepted = yield* enqueue(job);
          return accepted ? Option.some(deliveryId) : Option.none();
        });

      const snapshot = Effect.all({
        lanes: SynchronizedRef.get(lanes),
        control: SynchronizedRef.get(control),
      }).pipe(
        Effect.map(({ lanes: map, control: state }) => ({
          lanes: HashMap.size(map),
          depths: Object.fromEntries(
            [...HashMap.entries(map)].map(([threadId, lane]) => [
              threadId,
              lane.pending,
            ]),
          ),
          steerDepth: state.steerPending,
        })),
      );

      const stopAccepting = SynchronizedRef.update(control, (state) => ({
        ...state,
        accepting: false,
      }));

      const pendingCount = Effect.all({
        lanes: SynchronizedRef.get(lanes),
        control: SynchronizedRef.get(control),
      }).pipe(
        Effect.map(({ lanes: map, control: state }) =>
          state.steerPending +
          [...HashMap.values(map)].reduce(
            (total, lane) => total + lane.pending,
            0,
          ),
        ),
      );

      const drain: DeliveryService["drain"] = (timeout) =>
        Effect.gen(function* () {
          const deadline =
            Date.now() + Duration.toMillis(Duration.decode(timeout));
          while ((yield* pendingCount) > 0) {
            if (Date.now() >= deadline) return false;
            yield* Effect.sleep("10 millis");
          }
          return true;
        });

      return Delivery.of({
        submit,
        snapshot,
        stopAccepting,
        drain,
      });
    }),
  );
}
