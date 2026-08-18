import { Context, Data, Duration, Effect, Layer, Schema } from "effect";
import type { ThreadId, TransportId } from "../types.js";
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

// Generated from the complete app-server v2 ThreadSourceKind schema in Codex
// CLI 0.147.0. Omitting this field excludes non-interactive tasks, so an older
// incompatible server must fail visibly instead of returning a partial store.
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
}

export class AppServerTaskFailure extends Data.TaggedError(
  "AppServerTaskFailure",
)<{
  readonly reason: "unavailable" | "request-failed" | "unsupported";
}> {}

export interface AppServerTaskService {
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
  ) => Effect.Effect<never, AppServerTaskFailure>;
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

// Desktop IPC exposes thread/resume only; task list/history/events require a
// full app-server peer.
const TASK_CAPABLE_TRANSPORTS: ReadonlyArray<TransportId> = [
  "daemon",
  "app-bundled",
  "cli",
];

function isTaskCapable(candidate: TransportId): boolean {
  return TASK_CAPABLE_TRANSPORTS.includes(candidate);
}

function canonicalCandidates(
  candidates: ReadonlyArray<TransportSpec>,
): ReadonlyArray<TransportSpec> {
  return candidates
    .filter((candidate) => isTaskCapable(candidate.id))
    .sort((left, right) =>
      TASK_CAPABLE_TRANSPORTS.indexOf(left.id) -
      TASK_CAPABLE_TRANSPORTS.indexOf(right.id),
    );
}

export function appServerTaskStatus(
  candidates: ReadonlyArray<TransportId>,
): AppServerTaskStatus {
  return {
    candidatesFound: candidates.some(isTaskCapable),
  };
}

function failure(reason: AppServerTaskFailure["reason"]): AppServerTaskFailure {
  return new AppServerTaskFailure({ reason });
}

function operationFailure(error: unknown): AppServerTaskFailure {
  return error instanceof AppServerTaskFailure
    ? error
    : failure("request-failed");
}

const CANDIDATE_CONNECTION_FAILURE = {
  _tag: "CandidateConnectionFailure",
} as const;

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
        candidates.pipe(
          Effect.flatMap((available) => {
            const attempt = (
              remaining: ReadonlyArray<TransportSpec>,
            ): Effect.Effect<A, AppServerTaskFailure> => {
              const candidate = remaining[0];
              if (candidate == null) {
                return Effect.fail(failure("unavailable"));
              }
              return Effect.scoped(
                provider.connect(candidate).pipe(
                  Effect.mapError(() => CANDIDATE_CONNECTION_FAILURE),
                  Effect.flatMap((peer) =>
                    operation(peer).pipe(
                      Effect.mapError(operationFailure),
                    ),
                  ),
                ),
              ).pipe(
                Effect.catchTag(
                  "CandidateConnectionFailure",
                  () => attempt(remaining.slice(1)),
                ),
              );
            };
            return attempt(available);
          }),
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
            ? Effect.fail(failure("unsupported"))
            : peer.observe((notification: AppServerNotification) => {
                listener(notification);
              }),
        );

      return AppServerTasks.of({ list, history, events });
    }),
  );
}
