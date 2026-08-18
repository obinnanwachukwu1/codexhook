import { Context, Data, Duration, Effect, Layer, Schema, Scope } from "effect";
import type { ThreadId } from "../types.js";
import type { AppServerNotification, AppServerPeer } from "../transport/rpc.js";
import { TransportProvider } from "../transport/provider.js";
import type { TransportSpec } from "../transport/spec.js";

const READ_TIMEOUT = Duration.seconds(30);

const Task = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  preview: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  status: Schema.Struct({ type: Schema.String }),
  turns: Schema.Array(Schema.Unknown),
});

const TaskList = Schema.Struct({
  data: Schema.Array(Task),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const TaskRead = Schema.Struct({ thread: Task });

export interface LocalTask {
  readonly id: ThreadId;
  readonly title: string;
  readonly preview: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: string;
}

export interface LocalTaskPage {
  readonly tasks: ReadonlyArray<LocalTask>;
  readonly nextCursor: string | null;
}

export interface LocalTaskHistory {
  readonly task: LocalTask;
  /** App-server owns the canonical history; codexhook does not persist a copy. */
  readonly turns: ReadonlyArray<unknown>;
}

export interface LocalTaskEvent {
  readonly method: string;
  readonly params: unknown;
}

export interface LocalTaskAccessStatus {
  readonly available: boolean;
  readonly candidates: ReadonlyArray<string>;
  readonly source: "app-server";
}

export class LocalTaskUnavailable extends Data.TaggedError(
  "LocalTaskUnavailable",
)<{ readonly detail: string }> {}

export interface LocalTaskAccessService {
  readonly status: Effect.Effect<LocalTaskAccessStatus>;
  readonly list: (options?: {
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
    readonly archived?: boolean | undefined;
  }) => Effect.Effect<LocalTaskPage, LocalTaskUnavailable>;
  readonly history: (
    threadId: ThreadId,
  ) => Effect.Effect<LocalTaskHistory, LocalTaskUnavailable>;
  readonly events: (
    listener: (event: LocalTaskEvent) => void,
  ) => Effect.Effect<never, LocalTaskUnavailable, Scope.Scope>;
}

export class LocalTaskAccess extends Context.Tag("codexhook/LocalTaskAccess")<
  LocalTaskAccess,
  LocalTaskAccessService
>() {}

function normalize(task: typeof Task.Type): LocalTask {
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
  return candidates
    .filter((candidate) => candidate._tag !== "Desktop")
    .sort((left, right) => {
      const order = { daemon: 0, "app-bundled": 1, cli: 2 } as const;
      return order[left.id] - order[right.id];
    });
}

function unavailable(error: unknown): LocalTaskUnavailable {
  const detail =
    error != null && typeof error === "object" && "detail" in error
      ? String(error.detail)
      : error instanceof Error
        ? error.message
        : String(error);
  return new LocalTaskUnavailable({ detail });
}

export function LocalTaskAccessLive(): Layer.Layer<
  LocalTaskAccess,
  never,
  TransportProvider
> {
  return Layer.effect(
    LocalTaskAccess,
    Effect.gen(function* () {
      const provider = yield* TransportProvider;
      const candidates = provider.candidates.pipe(
        Effect.map(canonicalCandidates),
      );

      const withPeer = <A>(
        operation: (peer: AppServerPeer) => Effect.Effect<A, unknown>,
      ): Effect.Effect<A, LocalTaskUnavailable> =>
        Effect.scoped(
          candidates.pipe(
            Effect.flatMap((available) => {
              const attempt = (
                remaining: ReadonlyArray<TransportSpec>,
                last?: unknown,
              ): Effect.Effect<A, LocalTaskUnavailable, Scope.Scope> => {
                const candidate = remaining[0];
                if (candidate == null) {
                  return Effect.fail(
                    unavailable(last ?? "no local app-server is available"),
                  );
                }
                return provider.connect(candidate).pipe(
                  Effect.flatMap(operation),
                  Effect.mapError(unavailable),
                  Effect.catchAll((error) =>
                    attempt(remaining.slice(1), error),
                  ),
                );
              };
              return attempt(available);
            }),
          ),
        );

      const list: LocalTaskAccessService["list"] = (options = {}) =>
        withPeer((peer) =>
          peer.request(
            "thread/list",
            {
              cursor: options.cursor,
              limit: options.limit,
              archived: options.archived,
              sortKey: "updated_at",
              sortDirection: "desc",
              sourceKinds: [],
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

      const history: LocalTaskAccessService["history"] = (threadId) =>
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

      const events: LocalTaskAccessService["events"] = (listener) =>
        candidates.pipe(
          Effect.flatMap((available) => {
            const candidate = available[0];
            if (candidate == null) {
              return Effect.fail(
                new LocalTaskUnavailable({
                  detail: "no local app-server is available",
                }),
              );
            }
            return provider.connect(candidate).pipe(
              Effect.flatMap((peer) =>
                peer.observe((notification: AppServerNotification) => {
                  listener(notification);
                }),
              ),
              Effect.mapError(unavailable),
            );
          }),
        );

      const status = candidates.pipe(
        Effect.map((available) => ({
          available: available.length > 0,
          candidates: available.map((candidate) => candidate.id),
          source: "app-server" as const,
        })),
      );
      return LocalTaskAccess.of({ status, list, history, events });
    }),
  );
}
