import { Duration, Effect, Either, Schema } from "effect";
import type { AppServerPeer } from "../transport/rpc.js";
import {
  CanonicalQueryFailure,
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
const MAX_PAGES = 10_000;
export type AppServerTaskProvenance =
  | {
      readonly status: "known";
      readonly origin: "cli" | "vscode" | "exec" | "mcp" | "subagent";
      readonly source: SessionSource;
    }
  | { readonly status: "unknown"; readonly source: unknown }
  | { readonly status: "unavailable" };

export interface CanonicalTask {
  readonly thread: CanonicalThread;
  readonly provenance: AppServerTaskProvenance;
}

export type CanonicalTaskHistory = CanonicalTask;

export interface CanonicalEvent {
  readonly method: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
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
  | { readonly status: "absent" }
  | {
      readonly status: "indeterminate";
      readonly reason: "items-not-fully-loaded";
    };

export interface TurnInputRequest {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly input: ReadonlyArray<unknown>;
}

export interface TurnSteerRequest extends TurnInputRequest {
  readonly expectedTurnId: string;
}

function provenance(
  source: unknown,
): AppServerTaskProvenance {
  if (source == null) return { status: "unavailable" };
  if (typeof source === "string") {
    if (
      source === "cli" ||
      source === "vscode" ||
      source === "exec" ||
      source === "mcp"
    ) {
      return { status: "known", origin: source, source };
    }
    return { status: "unknown", source };
  }
  if (typeof source === "object" && "subagent" in source) {
    return { status: "known", origin: "subagent", source };
  }
  return { status: "unknown", source };
}

function eventThreadId(params: unknown): string | null {
  if (params == null || typeof params !== "object") return null;
  const value = (params as { readonly threadId?: unknown }).threadId;
  return typeof value === "string" ? value : null;
}

function eventTurnId(params: unknown): string | null {
  if (params == null || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (typeof record.turnId === "string") return record.turnId;
  if (record.turn == null || typeof record.turn !== "object") return null;
  const turnId = (record.turn as { readonly id?: unknown }).id;
  return typeof turnId === "string" ? turnId : null;
}

function paginationFailure(): CanonicalQueryFailure {
  return new CanonicalQueryFailure({ code: "pagination" });
}

function queryFailure(error: { readonly _tag: string }): CanonicalQueryFailure {
  const code = error._tag === "RpcNotWritten"
    ? "not-written"
    : error._tag === "RpcWriteAmbiguous"
      ? "write-ambiguous"
      : error._tag === "RpcErrorReply"
        ? "request-rejected"
        : error._tag === "RpcDisconnected"
          ? "disconnected"
          : error._tag === "RpcTimeout"
            ? "timeout"
            : "malformed";
  return new CanonicalQueryFailure({ code });
}

function ambiguousReason(
  error: { readonly _tag: string },
): "disconnected" | "timeout" | "malformed" {
  return error._tag === "RpcDisconnected"
    ? "disconnected"
    : error._tag === "RpcTimeout"
      ? "timeout"
      : "malformed";
}

export class CanonicalAppServerClient {
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
      ).pipe(Effect.mapError(queryFailure));
      const hydrated = yield* this.readTurns(threadId);
      if (!hydrated.allItemsFull) {
        return yield* new CanonicalQueryFailure({
          code: "history-incomplete",
        });
      }
      return {
        thread: { ...metadata.thread, turns: hydrated.turns },
        provenance: provenance(metadata.thread.source),
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
        return turns.some((turn) => turn.itemsView !== "full")
          ? {
              status: "indeterminate" as const,
              reason: "items-not-fully-loaded" as const,
            }
          : { status: "absent" as const };
      }),
    );
  }

  startTurn(
    request: TurnInputRequest,
  ): Effect.Effect<CanonicalMutationResult<typeof TurnStartResponse.Type>> {
    return this.mutate(
      "turn/start",
      request,
      TurnStartResponse,
    );
  }

  steerTurn(
    request: TurnSteerRequest,
  ): Effect.Effect<CanonicalMutationResult<typeof TurnSteerResponse.Type>> {
    return this.mutate(
      "turn/steer",
      request,
      TurnSteerResponse,
    );
  }

  interruptTurn(
    threadId: string,
    turnId: string,
  ): Effect.Effect<CanonicalMutationResult<unknown>> {
    return this.mutate(
      "turn/interrupt",
      { threadId, turnId },
      TurnInterruptResponse,
    );
  }

  subscribe(listener: (event: CanonicalEvent) => void): () => void {
    return this.peer.onNotification((message) => {
      listener({
        method: message.method,
        threadId: eventThreadId(message.params),
        turnId: eventTurnId(message.params),
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
          ).pipe(Effect.mapError(queryFailure));
        data.push(...page.data);
        if (page.nextCursor != null && seen.has(page.nextCursor)) {
          return yield* paginationFailure();
        }
        if (page.nextCursor != null) seen.add(page.nextCursor);
        cursor = page.nextCursor;
        if (seen.size >= MAX_PAGES && cursor != null) {
          return yield* paginationFailure();
        }
      } while (cursor != null);
      return data;
    });
  }

  private readTurns(threadId: string): Effect.Effect<{
    readonly turns: ReadonlyArray<CanonicalTurn>;
    readonly allItemsFull: boolean;
  }, CanonicalQueryError> {
    return Effect.gen(this, function* () {
      const turns: CanonicalTurn[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let allItemsFull = true;
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
          ).pipe(Effect.mapError(queryFailure));
        turns.push(...page.data);
        allItemsFull &&= page.data.every(
          (turn) => turn.itemsView === "full",
        );
        if (page.nextCursor != null && seen.has(page.nextCursor)) {
          return yield* paginationFailure();
        }
        if (page.nextCursor != null) seen.add(page.nextCursor);
        cursor = page.nextCursor;
        if (seen.size >= MAX_PAGES && cursor != null) {
          return yield* paginationFailure();
        }
      } while (cursor != null);
      return { turns, allItemsFull };
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
          reason: "pre-submit-failure",
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
              reason: "pre-submit-failure",
            }
          : {
              truth: "ambiguous",
              operation,
              reason: "write-error",
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
            rpcCode: replied.left.code,
          }
        : {
            truth: "ambiguous",
            operation,
            reason: ambiguousReason(replied.left),
          };
    });
  }
}
