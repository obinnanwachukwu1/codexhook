import { Duration, Effect, Option, Schema, Scope } from "effect";
import type { AppServerPeer } from "../transport/rpc.js";
import { CanonicalQueryFailure, type CanonicalMutationResult } from "./errors.js";
import {
  ALL_LOCAL_SOURCE_KINDS,
  type CanonicalThread,
  type CanonicalTurn,
  SessionSource,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadTurnsListResponse,
  TurnInterruptResponse,
  USER_MESSAGE_CLIENT_ID_FIELD,
} from "./schema.js";
import {
  TurnStartResult,
  TurnSteerResult,
} from "../transport/protocol.js";
import { paginate } from "./pagination.js";
import { mutate } from "./mutation.js";

const REQUEST_TIMEOUT = Duration.seconds(30);
const PAGE_SIZE = 100;
export type AppServerTaskProvenance =
  | {
      readonly status: "known";
      readonly origin:
        | "cli"
        | "vscode"
        | "exec"
        | "app-server"
        | "subagent"
        | "desktop";
    }
  | {
      readonly status: "unknown";
      readonly kind: "custom" | "internal" | "other";
    }
  | { readonly status: "unavailable" };
export interface CanonicalTask {
  readonly thread: CanonicalThread;
  readonly provenance: AppServerTaskProvenance;
}
export type CanonicalEvent =
  | {
      readonly type: "event";
      readonly method: string;
      readonly threadId: string | null;
      readonly turnId: string | null;
    }
  | { readonly type: "closed" };

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
  const decodable = typeof source === "string" || (
    typeof source === "object" && source != null &&
    ("custom" in source || "subAgent" in source)
  );
  const decoded = decodable
    ? Schema.decodeUnknownOption(SessionSource)(source)
    : Option.none();
  if (Option.isSome(decoded)) {
    const value = decoded.value;
    if (value === "cli" || value === "vscode" || value === "exec") {
      return { status: "known", origin: value };
    }
    if (value === "appServer") {
      return { status: "known", origin: "app-server" };
    }
    if (typeof value === "object" && "subAgent" in value) {
      return { status: "known", origin: "subagent" };
    }
    if (typeof value === "object" && "custom" in value) {
      if (value.custom === "desktop") {
        return { status: "known", origin: "desktop" };
      }
      return { status: "unknown", kind: "custom" };
    }
  }
  if (typeof source === "object" && source != null && "internal" in source) {
    return { status: "unknown", kind: "internal" };
  }
  return { status: "unknown", kind: "other" };
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

function queryFailure(error: { readonly _tag: string }): CanonicalQueryFailure {
  switch (error._tag) {
    case "RpcNotWritten":
    case "RpcDisconnected":
      return new CanonicalQueryFailure({ code: "disconnected" });
    case "RpcWriteAmbiguous":
      return new CanonicalQueryFailure({ code: "request-ambiguous" });
    case "RpcErrorReply":
      return new CanonicalQueryFailure({ code: "request-rejected" });
    case "RpcTimeout":
      return new CanonicalQueryFailure({ code: "timeout" });
    default:
      return new CanonicalQueryFailure({ code: "malformed" });
  }
}

/**
 * Mutation effects never retry. Interruption after submission is ambiguous;
 * supervising delivery policy must reconcile it and must not resubmit.
 */
export class CanonicalAppServerClient {
  constructor(readonly peer: AppServerPeer) {}

  listTasks(): Effect.Effect<ReadonlyArray<CanonicalTask>, CanonicalQueryFailure> {
    return Effect.all([
      this.listArchive(false),
      this.listArchive(true),
    ]).pipe(
      Effect.map(([current, archived]) => {
        const tasks = new Map<string, CanonicalThread>();
        for (const thread of [...archived, ...current]) {
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
  ): Effect.Effect<CanonicalTask, CanonicalQueryFailure> {
    return Effect.gen(this, function* () {
      const metadata = yield* this.readTask(threadId);
      const hydrated = yield* this.readTurns(threadId);
      if (!hydrated.allItemsFull) {
        return yield* new CanonicalQueryFailure({
          code: "history-incomplete",
        });
      }
      return {
        ...metadata,
        thread: { ...metadata.thread, turns: hydrated.turns },
      };
    });
  }

  readTask(
    threadId: string,
  ): Effect.Effect<CanonicalTask, CanonicalQueryFailure> {
    return this.peer.request(
      "thread/read",
      { threadId, includeTurns: false },
      ThreadReadResponse,
      REQUEST_TIMEOUT,
    ).pipe(
      Effect.mapError(queryFailure),
      Effect.flatMap(({ thread }) => thread.id === threadId
        ? Effect.succeed({ thread, provenance: provenance(thread.source) })
        : Effect.fail(new CanonicalQueryFailure({ code: "malformed" }))),
    );
  }

  verifyTurn(
    threadId: string,
    turnId: string,
  ): Effect.Effect<TurnVerification, CanonicalQueryFailure> {
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
  ): Effect.Effect<MessageVerification, CanonicalQueryFailure> {
    return this.readTurns(threadId).pipe(
      Effect.map(({ turns }) => {
        for (const turn of turns) {
          const item = turn.items.find((candidate) => {
            if (candidate == null || typeof candidate !== "object") {
              return false;
            }
            const record = candidate as Record<string, unknown>;
            return record.type === "userMessage" &&
              record[USER_MESSAGE_CLIENT_ID_FIELD] === clientUserMessageId;
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
    timeout: Duration.DurationInput = REQUEST_TIMEOUT,
  ): Effect.Effect<CanonicalMutationResult<typeof TurnStartResult.Type>> {
    return this.mutate(
      "turn/start",
      request,
      TurnStartResult,
      timeout,
    );
  }

  steerTurn(
    request: TurnSteerRequest,
    timeout: Duration.DurationInput = REQUEST_TIMEOUT,
  ): Effect.Effect<CanonicalMutationResult<typeof TurnSteerResult.Type>> {
    return this.mutate(
      "turn/steer",
      request,
      TurnSteerResult,
      timeout,
    );
  }

  interruptTurn(
    threadId: string,
    turnId: string,
    timeout: Duration.DurationInput = REQUEST_TIMEOUT,
  ): Effect.Effect<CanonicalMutationResult<unknown>> {
    return this.mutate(
      "turn/interrupt",
      { threadId, turnId },
      TurnInterruptResponse,
      timeout,
    );
  }

  subscribe(
    listener: (event: CanonicalEvent) => void,
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => this.peer.onNotification(
        (message) => {
          listener({
            type: "event",
            method: message.method,
            threadId: eventThreadId(message.params),
            turnId: eventTurnId(message.params),
          });
        },
        () => listener({ type: "closed" }),
      )),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid);
  }

  private listArchive(
    archived: boolean,
  ): Effect.Effect<ReadonlyArray<CanonicalThread>, CanonicalQueryFailure> {
    return paginate((cursor) =>
      this.peer.request(
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
      ).pipe(Effect.mapError(queryFailure))
    );
  }

  private readTurns(threadId: string): Effect.Effect<{
    readonly turns: ReadonlyArray<CanonicalTurn>;
    readonly allItemsFull: boolean;
  }, CanonicalQueryFailure> {
    return paginate((cursor) =>
      this.peer.request(
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
      ).pipe(Effect.mapError(queryFailure))
    ).pipe(
      Effect.map((turns) => ({
        turns,
        allItemsFull: turns.every((turn) => turn.itemsView === "full"),
      })),
    );
  }

  private mutate<A, I>(
    operation: "turn/start" | "turn/steer" | "turn/interrupt",
    params: unknown,
    schema: Schema.Schema<A, I>,
    timeout: Duration.DurationInput,
  ): Effect.Effect<CanonicalMutationResult<A>> {
    return mutate(this.peer, operation, params, schema, timeout);
  }
}
