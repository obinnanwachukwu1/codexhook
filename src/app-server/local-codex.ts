import { Effect, Layer, Stream } from "effect";
import {
  type DiagnosticCode,
  sanitizeDiagnostic,
} from "../contracts/diagnostics.js";
import {
  LocalCodex,
  type LocalCodexFailure,
  type LocalCodexService,
  type LocalSubmissionRequest,
  type LocalTaskHistory,
  type LocalTaskRef,
  type LocalTaskSummary,
  type LocalTurn,
  type TaskOrigin,
} from "../contracts/local-codex.js";
import type { RouteSubmissionOutcome } from "../contracts/submission.js";
import { DeliveryId, ThreadId, TurnId } from "../types.js";
import {
  type AppServerTaskProvenance,
  CanonicalAppServerClient,
  type CanonicalTask,
} from "./client.js";
import type {
  CanonicalMutationResult,
  CanonicalQueryFailure,
  CanonicalQueryFailureCode,
} from "./errors.js";
import type { CanonicalTurn } from "./schema.js";
import { appServerCompatibility } from "./local-compatibility.js";
import { localTaskEvents } from "./local-events.js";
import {
  CanonicalAppServer,
  CanonicalAppServerLive,
  type CanonicalAppServerService,
} from "./service.js";

function diagnostic(
  code: DiagnosticCode,
  stage: "check-app-server" | "resolve-task" | "submit-app-server",
) {
  return sanitizeDiagnostic({ code, stage, route: "app-server" });
}

function failure(
  code: CanonicalQueryFailureCode | "unavailable",
  stage: "resolve-task" | "check-app-server" = "resolve-task",
): LocalCodexFailure {
  const mapped = code === "disconnected"
    ? "disconnected"
    : code === "timeout"
      ? "timeout"
      : code === "request-ambiguous"
        ? "write-ambiguous"
        : code === "request-rejected"
          ? "request-rejected"
          : code === "malformed" || code === "history-incomplete"
            ? "app-server-incompatible"
            : code === "unavailable"
              ? "app-server-unavailable"
              : "internal";
  return { _tag: "LocalCodexFailure", diagnostic: diagnostic(mapped, stage) };
}

function originOf(provenance: AppServerTaskProvenance): TaskOrigin {
  if (provenance.status !== "known") return "unknown";
  if (provenance.origin === "desktop") return "desktop";
  if (provenance.origin === "cli" || provenance.origin === "exec") {
    return "cli";
  }
  return "unknown";
}

function taskRef(task: CanonicalTask): LocalTaskRef {
  return {
    threadId: ThreadId(task.thread.id),
    origin: originOf(task.provenance),
  } as LocalTaskRef;
}

function titleOf(task: CanonicalTask): string | null {
  const title = task.thread.name?.trim() || task.thread.preview.trim();
  return title.length === 0 ? null : title;
}

function taskSummary(task: CanonicalTask): LocalTaskSummary {
  return {
    ...taskRef(task),
    title: titleOf(task),
    updatedAt: task.thread.updatedAt,
  };
}

function turnStatus(
  status: string,
): LocalTurn["status"] | null {
  if (status === "inProgress") return "in-progress";
  if (
    status === "completed" || status === "interrupted" || status === "failed"
  ) {
    return status;
  }
  return null;
}

function deliveryIds(turn: CanonicalTurn): ReadonlyArray<DeliveryId> {
  const ids = new Set<DeliveryId>();
  for (const item of turn.items) {
    if (item == null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "userMessage" || typeof record.clientId !== "string") {
      continue;
    }
    ids.add(DeliveryId(record.clientId));
  }
  return [...ids];
}

function localTurn(
  turn: CanonicalTurn,
): Effect.Effect<LocalTurn, LocalCodexFailure> {
  const status = turnStatus(turn.status);
  if (status == null || turn.itemsView !== "full") {
    return Effect.fail(failure("malformed"));
  }
  return Effect.succeed({
    id: TurnId(turn.id),
    status,
    deliveryIds: deliveryIds(turn),
  });
}

function history(
  task: CanonicalTask,
): Effect.Effect<LocalTaskHistory, LocalCodexFailure> {
  return Effect.all(task.thread.turns.map(localTurn)).pipe(
    Effect.map((turns) => ({ task: taskRef(task), turns })),
  );
}

function query<A>(
  effect: Effect.Effect<A, CanonicalQueryFailure>,
): Effect.Effect<A, LocalCodexFailure> {
  return effect.pipe(Effect.mapError((error) => failure(error.code)));
}

function unavailableOutcome(
  request: LocalSubmissionRequest,
  code: "app-server-unavailable" | "request-rejected",
  reason: "unavailable" | "incompatible" | "pre-submit-failure" =
    "pre-submit-failure",
): RouteSubmissionOutcome<"app-server"> {
  return {
    _tag: "NotSubmitted",
    route: "app-server",
    deliveryId: request.deliveryId,
    reason,
    diagnostic: diagnostic(code, "submit-app-server"),
  };
}

function mutationOutcome<A>(
  request: LocalSubmissionRequest,
  operation: "start" | "steer",
  result: CanonicalMutationResult<A>,
  confirmedTurn: (value: A) => string,
): RouteSubmissionOutcome<"app-server"> {
  if (result.truth === "confirmed-app-server") {
    return {
      _tag: "Confirmed",
      route: "app-server",
      deliveryId: request.deliveryId,
      turnId: TurnId(confirmedTurn(result.value)),
      operation,
    };
  }
  if (result.truth === "rejected") {
    return {
      _tag: "Rejected",
      route: "app-server",
      deliveryId: request.deliveryId,
      diagnostic: diagnostic("request-rejected", "submit-app-server"),
    };
  }
  if (result.truth === "unavailable") {
    return unavailableOutcome(request, "app-server-unavailable");
  }
  const code = result.reason === "timeout"
    ? "timeout"
    : result.reason === "disconnected"
      ? "disconnected"
      : "write-ambiguous";
  return {
    _tag: "Ambiguous",
    route: "app-server",
    deliveryId: request.deliveryId,
    diagnostic: diagnostic(code, "submit-app-server"),
  };
}

export function localCodexService(
  canonical: CanonicalAppServerService,
): LocalCodexService {
  const client = canonical.client;
  const compatibility = client == null ? null : appServerCompatibility(client);
  const usable = compatibility?.status === "available" ? client : null;
  const unavailable = client == null
    ? failure("unavailable", "check-app-server")
    : failure("malformed", "check-app-server");
  return {
    availability: canonical.availability.pipe(
      Effect.map((value) => value.status === "available"
        ? compatibility != null
          ? compatibility
          : {
            status: "incompatible" as const,
            diagnostic: diagnostic(
              "app-server-incompatible",
              "check-app-server",
            ),
          }
        : {
          status: "unavailable" as const,
          diagnostic: diagnostic(
            value.reason === "disconnected"
              ? "disconnected"
              : "app-server-unavailable",
            "check-app-server",
          ),
        }),
    ),
    listTasks: usable == null
      ? Effect.fail(unavailable)
      : query(usable.listTasks()).pipe(Effect.map((tasks) => tasks.map(taskSummary))),
    readHistory: (task) => usable == null
      ? Effect.fail(unavailable)
      : query(usable.readTaskHistory(task.threadId)).pipe(Effect.flatMap(history)),
    resolveTask: (threadId) => usable == null
      ? Effect.fail(unavailable)
      : query(usable.readTask(threadId)).pipe(
        Effect.map(taskRef),
      ),
    events: (task) => usable == null
      ? Stream.fail(unavailable)
      : localTaskEvents(
        usable,
        task,
        () => query(usable.readTaskHistory(task.threadId)).pipe(
          Effect.flatMap(history),
        ),
        failure("disconnected"),
      ),
    submit: (request) => {
      if (usable == null) {
        return Effect.succeed(
          unavailableOutcome(
            request,
            "app-server-unavailable",
            client == null ? "unavailable" : "incompatible",
          ),
        );
      }
      if (request.mode === "queue") {
        return query(usable.readTask(request.task.threadId)).pipe(
          Effect.flatMap(() => usable.startTurn({
            threadId: request.task.threadId,
            clientUserMessageId: request.deliveryId,
            input: [{ type: "text", text: request.message }],
          }, request.replyTimeout)),
          Effect.map((result) => mutationOutcome(
            request,
            "start",
            result,
            (value) => value.turn.id,
          )),
          Effect.catchAllCause(() => Effect.succeed(
            unavailableOutcome(request, "app-server-unavailable"),
          )),
        );
      }
      return query(usable.readTaskHistory(request.task.threadId)).pipe(
        Effect.flatMap((task) => {
          const active = task.thread.turns.filter(
            (turn) => turn.status === "inProgress",
          );
          if (active.length !== 1) {
            return Effect.succeed(
              unavailableOutcome(request, "request-rejected"),
            );
          }
          return usable.steerTurn({
            threadId: request.task.threadId,
            expectedTurnId: active[0]!.id,
            clientUserMessageId: request.deliveryId,
            input: [{ type: "text", text: request.message }],
          }, request.replyTimeout).pipe(
            Effect.map((result) => mutationOutcome(
              request,
              "steer",
              result,
              (value) => value.turnId,
            )),
          );
        }),
        Effect.catchAllCause(() => Effect.succeed(
          unavailableOutcome(request, "app-server-unavailable"),
        )),
      );
    },
  };
}

const LocalCodexFromCanonical = Layer.effect(
  LocalCodex,
  Effect.map(CanonicalAppServer, localCodexService),
);

export const LocalCodexLive = LocalCodexFromCanonical.pipe(
  Layer.provide(CanonicalAppServerLive),
);
