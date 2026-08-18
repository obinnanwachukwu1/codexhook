import { Effect, Option, Queue, Stream } from "effect";
import type {
  LocalCodexFailure,
  LocalTaskEvent,
  LocalTaskHistory,
  LocalTaskRef,
  LocalTurn,
} from "../contracts/local-codex.js";
import type {
  CanonicalAppServerClient,
} from "./client.js";

type Signal = "refresh" | "removed" | "closed";

const STATE_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "turn/interrupted",
  "item/started",
  "item/completed",
  "thread/updated",
]);

function sameTurn(left: LocalTurn, right: LocalTurn): boolean {
  return left.id === right.id && left.status === right.status &&
    left.deliveryIds.length === right.deliveryIds.length &&
    left.deliveryIds.every((id, index) => id === right.deliveryIds[index]);
}

function changedTurns(
  previous: LocalTaskHistory,
  next: LocalTaskHistory,
): ReadonlyArray<LocalTaskEvent> {
  const before = new Map(previous.turns.map((turn) => [turn.id, turn]));
  return next.turns.flatMap((turn) => {
    const prior = before.get(turn.id);
    return prior == null || !sameTurn(prior, turn)
      ? [{ type: "turn-changed" as const, task: next.task, turn }]
      : [];
  });
}

export function localTaskEvents(
  client: CanonicalAppServerClient,
  task: LocalTaskRef,
  loadHistory: () => Effect.Effect<LocalTaskHistory, LocalCodexFailure>,
  disconnected: LocalCodexFailure,
): Stream.Stream<LocalTaskEvent, LocalCodexFailure> {
  return Stream.unwrapScoped(Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Signal>();
    let refreshQueued = false;
    let removed = false;
    let closed = false;
    yield* client.subscribe((event) => {
      if (event.type === "closed") {
        if (!closed) {
          closed = true;
          Effect.runFork(Queue.offer(queue, "closed"));
        }
        return;
      }
      if (event.threadId !== task.threadId || closed) return;
      if (event.method === "thread/deleted") {
        if (!removed) {
          removed = true;
          Effect.runFork(Queue.offer(queue, "removed"));
        }
        return;
      }
      if (!removed && STATE_METHODS.has(event.method) && !refreshQueued) {
        refreshQueued = true;
        Effect.runFork(Queue.offer(queue, "refresh"));
      }
    });
    let previous = yield* loadHistory();
    const updates = Stream.fromQueue(queue).pipe(
      Stream.mapEffect((signal) => {
        if (signal === "closed") return Effect.fail(disconnected);
        if (signal === "removed") {
          return Effect.succeed(Option.some<LocalTaskEvent>({
            type: "task-removed",
            task,
          }));
        }
        refreshQueued = false;
        if (removed || closed) {
          return Effect.succeed(
            Option.none<LocalTaskHistory | LocalTaskEvent>(),
          );
        }
        return loadHistory().pipe(
          Effect.map((value) => Option.some<LocalTaskHistory | LocalTaskEvent>(
            value,
          )),
        );
      }),
      Stream.filterMap((value) => value),
      Stream.mapConcat((next) => {
        if ("type" in next) return [next];
        const events = changedTurns(previous, next);
        previous = next;
        return events;
      }),
    );
    return Stream.concat(
      Stream.succeed({ type: "snapshot" as const, history: previous }),
      updates,
    );
  }));
}
