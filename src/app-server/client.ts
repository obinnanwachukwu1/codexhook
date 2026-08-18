import { Duration, Effect, Either, Schema } from "effect";
import type { AppServerPeer } from "../transport/rpc.js";
import { APP_SERVER_COMPATIBILITY } from "./compatibility.js";
import {
  CanonicalPaginationError,
  type CanonicalMutationResult,
  type CanonicalQueryError,
  type MutationOperation,
} from "./errors.js";
import {
  ALL_LOCAL_SOURCE_KINDS,
  type CanonicalThread,
  type CanonicalTurn,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadTurnsListResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
  type SessionSource,
} from "./schema.js";

const REQUEST_TIMEOUT = Duration.seconds(30);
const PAGE_SIZE = 100;

export type TaskProvenance =
  | {
      readonly status: "known";
      readonly origin: "cli" | "vscode" | "exec" | "mcp" | "subagent";
      readonly source: SessionSource;
    }
  | { readonly status: "unknown"; readonly source: SessionSource }
  | { readonly status: "unavailable" };

export interface CanonicalTask {
  readonly thread: CanonicalThread;
  readonly provenance: TaskProvenance;
}

export interface CanonicalTaskHistory extends CanonicalTask {
  readonly completeness: "complete";
  readonly pagesRead: number;
}

export interface CanonicalEvent {
  readonly scope: "local-machine";
  readonly method: string;
  readonly params?: unknown;
  readonly threadId: string | null;
}

export type TurnVerification =
  | { readonly status: "confirmed"; readonly turn: CanonicalTurn }
  | { readonly status: "absent" };

export type MessageVerification =
  | {
      readonly status: "confirmed";
      readonly turn: CanonicalTurn;
      readonly item: unknown;
    }
  | { readonly status: "absent" };

export interface TurnInputRequest {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly input: ReadonlyArray<unknown>;
}

export interface TurnSteerRequest extends TurnInputRequest {
  readonly expectedTurnId: string;
}

function provenance(source: SessionSource | undefined): TaskProvenance {
  if (source == null) return { status: "unavailable" };
  if (typeof source === "string") {
    if (source === "cli" || source === "vscode" || source === "exec") {
      return { status: "known", origin: source, source };
    }
    if (source === "mcp") {
      return { status: "known", origin: "mcp", source };
    }
    return { status: "unknown", source };
  }
  if ("subagent" in source) {
    return { status: "known", origin: "subagent", source };
  }
  return { status: "unknown", source };
}

function eventThreadId(params: unknown): string | null {
  if (params == null || typeof params !== "object") return null;
  const value = (params as { readonly threadId?: unknown }).threadId;
  return typeof value === "string" ? value : null;
}

function paginationFailure(
  method: "thread/list" | "thread/turns/list",
  cursor: string,
): CanonicalPaginationError {
  return new CanonicalPaginationError({
    method,
    detail: `app-server repeated pagination cursor ${cursor}`,
  });
}

function mutationDetail(error: { readonly _tag: string }): string {
  if ("detail" in error) return String(error.detail);
  if ("millis" in error) return `timed out after ${String(error.millis)}ms`;
  return error._tag;
}

export class CanonicalAppServerClient {
  readonly compatibility = APP_SERVER_COMPATIBILITY;

  constructor(readonly peer: AppServerPeer) {}

  listTasks(): Effect.Effect<ReadonlyArray<CanonicalTask>, CanonicalQueryError> {
    return Effect.all([
      this.listArchive(false),
      this.listArchive(true),
    ]).pipe(
      Effect.map(([current, archived]) => {
        const tasks = new Map<string, CanonicalThread>();
        for (const thread of [...current, ...archived]) {
          tasks.set(thread.id, thread);
        }
        return [...tasks.values()]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .map((thread) => ({
            thread,
            provenance: provenance(thread.source),
          }));
      }),
    );
  }

  readTaskHistory(
    threadId: string,
  ): Effect.Effect<CanonicalTaskHistory, CanonicalQueryError> {
    return Effect.gen(this, function* () {
      const metadata = yield* this.peer.request(
        "thread/read",
        { threadId, includeTurns: false },
        ThreadReadResponse,
        REQUEST_TIMEOUT,
      );
      const hydrated = yield* this.readTurns(threadId);
      return {
        thread: { ...metadata.thread, turns: hydrated.turns },
        provenance: provenance(metadata.thread.source),
        completeness: "complete",
        pagesRead: hydrated.pages,
      };
    });
  }

  verifyTurn(
    threadId: string,
    turnId: string,
  ): Effect.Effect<TurnVerification, CanonicalQueryError> {
    return this.readTurns(threadId).pipe(
      Effect.map(({ turns }) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        return turn == null
          ? { status: "absent" as const }
          : { status: "confirmed" as const, turn };
      }),
    );
  }

  verifyClientMessage(
    threadId: string,
    clientUserMessageId: string,
  ): Effect.Effect<MessageVerification, CanonicalQueryError> {
    return this.readTurns(threadId).pipe(
      Effect.map(({ turns }) => {
        for (const turn of turns) {
          const item = turn.items.find((candidate) => {
            if (candidate == null || typeof candidate !== "object") {
              return false;
            }
            const record = candidate as Record<string, unknown>;
            return record.type === "userMessage" &&
              record.clientId === clientUserMessageId;
          });
          if (item != null) return { status: "confirmed" as const, turn, item };
        }
        return { status: "absent" as const };
      }),
    );
  }

  startTurn(request: TurnInputRequest) {
    return this.mutate(
      "turn/start",
      request,
      TurnStartResponse,
    );
  }

  steerTurn(request: TurnSteerRequest) {
    return this.mutate(
      "turn/steer",
      request,
      TurnSteerResponse,
    );
  }

  interruptTurn(threadId: string, turnId: string) {
    return this.mutate(
      "turn/interrupt",
      { threadId, turnId },
      TurnInterruptResponse,
    );
  }

  subscribe(listener: (event: CanonicalEvent) => void): () => void {
    return this.peer.onNotification((message) => {
      listener({
        scope: "local-machine",
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
        threadId: eventThreadId(message.params),
      });
    });
  }

  private listArchive(
    archived: boolean,
  ): Effect.Effect<ReadonlyArray<CanonicalThread>, CanonicalQueryError> {
    return Effect.gen(this, function* () {
      const data: CanonicalThread[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: typeof ThreadListResponse.Type =
          yield* this.peer.request(
            "thread/list",
            {
              cursor,
              limit: PAGE_SIZE,
              sortKey: "updated_at",
              sortDirection: "desc",
              sourceKinds: [...ALL_LOCAL_SOURCE_KINDS],
              archived,
            },
            ThreadListResponse,
            REQUEST_TIMEOUT,
          );
        data.push(...page.data);
        if (page.nextCursor != null && seen.has(page.nextCursor)) {
          return yield* paginationFailure("thread/list", page.nextCursor);
        }
        if (page.nextCursor != null) seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor != null);
      return data;
    });
  }

  private readTurns(threadId: string): Effect.Effect<{
    readonly turns: ReadonlyArray<CanonicalTurn>;
    readonly pages: number;
  }, CanonicalQueryError> {
    return Effect.gen(this, function* () {
      const turns: CanonicalTurn[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: typeof ThreadTurnsListResponse.Type =
          yield* this.peer.request(
            "thread/turns/list",
            {
              threadId,
              cursor,
              limit: PAGE_SIZE,
              sortDirection: "asc",
              itemsView: "full",
            },
            ThreadTurnsListResponse,
            REQUEST_TIMEOUT,
          );
        pages += 1;
        turns.push(...page.data);
        if (page.nextCursor != null && seen.has(page.nextCursor)) {
          return yield* paginationFailure(
            "thread/turns/list",
            page.nextCursor,
          );
        }
        if (page.nextCursor != null) seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor != null);
      return { turns, pages };
    });
  }

  private mutate<A, I>(
    operation: MutationOperation,
    params: unknown,
    schema: Schema.Schema<A, I>,
  ): Effect.Effect<CanonicalMutationResult<A>> {
    return Effect.gen(this, function* () {
      const prepared = yield* Effect.either(
        this.peer.prepare(operation, params),
      );
      if (Either.isLeft(prepared)) {
        return {
          truth: "unavailable",
          operation,
          detail: prepared.left.detail,
        };
      }
      const submitted = yield* Effect.either(
        this.peer.submit(prepared.right),
      );
      if (Either.isLeft(submitted)) {
        return submitted.left._tag === "RpcNotWritten"
          ? {
              truth: "unavailable",
              operation,
              detail: submitted.left.detail,
            }
          : {
              truth: "ambiguous",
              operation,
              detail: submitted.left.detail,
            };
      }
      const replied = yield* Effect.either(
        this.peer.reply(prepared.right, schema, REQUEST_TIMEOUT),
      );
      if (Either.isRight(replied)) {
        return {
          truth: "confirmed-app-server",
          operation,
          value: replied.right,
        };
      }
      return replied.left._tag === "RpcErrorReply"
        ? {
            truth: "rejected",
            operation,
            code: replied.left.code,
            message: replied.left.message,
          }
        : {
            truth: "ambiguous",
            operation,
            detail: mutationDetail(replied.left),
          };
    });
  }
}
