import { Context, Data, Duration, Effect, Layer, Schema, Scope } from "effect";
import type { ThreadId } from "../types.js";
import type { AppServerNotification, AppServerPeer } from "../transport/rpc.js";
import { TransportProvider } from "../transport/provider.js";
import type { TransportSpec } from "../transport/spec.js";

const READ_TIMEOUT = Duration.seconds(30);

const TASK_FIELDS = {
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  preview: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  status: Schema.Struct({ type: Schema.String }),
} as const;

const Task = Schema.Struct(TASK_FIELDS);
const TaskWithTurns = Schema.Struct({
  ...TASK_FIELDS,
  turns: Schema.Array(Schema.Unknown),
});

const TaskList = Schema.Struct({
  data: Schema.Array(Task),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const TaskRead = Schema.Struct({ thread: TaskWithTurns });

// Empty sourceKinds uses app-server's interactive-only default. Enumerating
// the v2 source kinds keeps this machine-wide reader inclusive of CLI, app,
// exec, and sub-agent tasks.
const ALL_TASK_SOURCES = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export interface AppServerTask {
  readonly id: ThreadId;
  readonly title: string;
  readonly preview: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: string;
}

export interface AppServerTaskPage {
  readonly tasks: ReadonlyArray<AppServerTask>;
  readonly nextCursor: string | null;
}

export interface AppServerTaskHistory {
  readonly task: AppServerTask;
  /** App-server owns the canonical history; codexhook does not persist a copy. */
  readonly turns: ReadonlyArray<unknown>;
}

export interface AppServerTaskEvent {
  readonly method: string;
  readonly params: unknown;
}

export interface AppServerTaskStatus {
  readonly candidatesFound: boolean;
  readonly candidates: ReadonlyArray<string>;
  readonly source: "app-server";
}

export class AppServerTaskFailure extends Data.TaggedError(
  "AppServerTaskFailure",
)<{ readonly reason: "unavailable" | "request-failed" }> {}

export interface AppServerTaskService {
  readonly status: Effect.Effect<AppServerTaskStatus>;
  readonly list: (options?: {
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
    readonly archived?: boolean | undefined;
  }) => Effect.Effect<AppServerTaskPage, AppServerTaskFailure>;
  readonly history: (
    threadId: ThreadId,
  ) => Effect.Effect<AppServerTaskHistory, AppServerTaskFailure>;
  readonly events: (
    listener: (event: AppServerTaskEvent) => void,
  ) => Effect.Effect<never, AppServerTaskFailure, Scope.Scope>;
}

export class AppServerTasks extends Context.Tag("codexhook/AppServerTasks")<
  AppServerTasks,
  AppServerTaskService
>() {}

function normalize(task: typeof Task.Type): AppServerTask {
  return {
    id: task.id as ThreadId,
    title: task.name ?? task.preview,
    preview: task.preview,
    cwd: task.cwd,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    status: task.status.type,
  };
}

function canonicalCandidates(
  candidates: ReadonlyArray<TransportSpec>,
): ReadonlyArray<TransportSpec> {
  const order = ["daemon", "app-bundled", "cli"] as const;
  return candidates
    .filter((candidate) =>
      order.includes(candidate.id as (typeof order)[number]),
    )
    .sort((left, right) =>
      order.indexOf(left.id as (typeof order)[number]) -
      order.indexOf(right.id as (typeof order)[number]),
    );
}

function failure(reason: AppServerTaskFailure["reason"]): AppServerTaskFailure {
  return new AppServerTaskFailure({ reason });
}

export function AppServerTasksLive(): Layer.Layer<
  AppServerTasks,
  never,
  TransportProvider
> {
  return Layer.effect(
    AppServerTasks,
    Effect.gen(function* () {
      const provider = yield* TransportProvider;
      const candidates = provider.candidates.pipe(
        Effect.map(canonicalCandidates),
      );

      const withPeer = <A>(
        operation: (peer: AppServerPeer) => Effect.Effect<A, unknown>,
      ): Effect.Effect<A, AppServerTaskFailure> =>
        Effect.scoped(
          candidates.pipe(
            Effect.flatMap((available) => {
              const connect = (
                remaining: ReadonlyArray<TransportSpec>,
              ): Effect.Effect<
                AppServerPeer,
                AppServerTaskFailure,
                Scope.Scope
              > => {
                const candidate = remaining[0];
                if (candidate == null) {
                  return Effect.fail(failure("unavailable"));
                }
                return provider.connect(candidate).pipe(
                  Effect.mapError(() => failure("unavailable")),
                  Effect.catchAll(() => connect(remaining.slice(1))),
                );
              };
              return connect(available).pipe(
                Effect.flatMap((peer) =>
                  operation(peer).pipe(
                    Effect.mapError(() => failure("request-failed")),
                  ),
                ),
              );
            }),
          ),
        );

      const list: AppServerTaskService["list"] = (options = {}) =>
        withPeer((peer) =>
          peer.request(
            "thread/list",
            {
              cursor: options.cursor,
              limit: options.limit,
              archived: options.archived,
              sortKey: "updated_at",
              sortDirection: "desc",
              sourceKinds: ALL_TASK_SOURCES,
            },
            TaskList,
            READ_TIMEOUT,
          ),
        ).pipe(
          Effect.map((page) => ({
            tasks: page.data.map(normalize),
            nextCursor: page.nextCursor ?? null,
          })),
        );

      const history: AppServerTaskService["history"] = (threadId) =>
        withPeer((peer) =>
          peer.request(
            "thread/read",
            { threadId, includeTurns: true },
            TaskRead,
            READ_TIMEOUT,
          ),
        ).pipe(
          Effect.map(({ thread }) => ({
            task: normalize(thread),
            turns: thread.turns,
          })),
        );

      const events: AppServerTaskService["events"] = (listener) =>
        withPeer((peer) =>
          peer.observe == null
            ? Effect.fail(new Error("notifications unsupported"))
            : peer.observe((notification: AppServerNotification) => {
                listener(notification);
              }),
        );

      const status = candidates.pipe(
        Effect.map((available) => ({
          candidatesFound: available.length > 0,
          candidates: available.map((candidate) => candidate.id),
          source: "app-server" as const,
        })),
      );
      return AppServerTasks.of({ status, list, history, events });
    }),
  );
}
