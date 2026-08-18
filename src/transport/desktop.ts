import { randomUUID } from "node:crypto";
import {
  Deferred,
  Duration,
  Effect,
  FiberId,
  Option,
  Schema,
  Scope,
} from "effect";
import {
  DesktopIpcClient,
  DesktopIpcConnectError,
} from "./desktop-ipc-client.js";
import { DesktopThreadState } from "./desktop-state.js";
import {
  TransportIncompatible,
  TransportUnavailable,
} from "./errors.js";
import {
  type AppServerPeer,
  RpcDisconnected,
  RpcErrorReply,
  RpcMalformed,
  RpcNotWritten,
  RpcTimeout,
  RpcWriteAmbiguous,
  type RpcTicket,
} from "./rpc.js";
import type { TransportSpec } from "./spec.js";

const IPC_VERSION = {
  start: 1,
  steer: 1,
  following: 1,
  history: 1,
} as const;

function durationMillis(value: Duration.DurationInput): number {
  return Duration.toMillis(Duration.decode(value));
}

function ticketPayload(ticket: RpcTicket): {
  readonly method: string;
  readonly params: Record<string, unknown>;
} {
  return JSON.parse(ticket.serialized) as {
    method: string;
    params: Record<string, unknown>;
  };
}

function nestedTurnId(value: unknown): string | null {
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.turnId === "string") return record.turnId;
  const turn = record.turn;
  if (
    turn != null &&
    typeof turn === "object" &&
    typeof (turn as { readonly id?: unknown }).id === "string"
  ) {
    return (turn as { readonly id: string }).id;
  }
  for (const child of Object.values(record)) {
    const found = nestedTurnId(child);
    if (found != null) return found;
  }
  return null;
}

function safeIpcRejection(error: string | undefined): boolean {
  if (error == null) return false;
  return [
    "no-client-found",
    "client-not-found",
    "client-cannot-handle-request",
    "request-version-mismatch",
    "no-handler-for-request",
    "thread stream owner became unavailable",
    "thread-role-timeout",
  ].some((value) => error.includes(value));
}

function makePeer(
  spec: Extract<TransportSpec, { readonly _tag: "Desktop" }>,
  client: DesktopIpcClient,
): AppServerPeer {
  const states = new Map<string, DesktopThreadState>();
  client.onBroadcast((message) => {
    for (const state of states.values()) {
      state.apply(message);
      if (state.takeResyncRequest()) {
        void client
          .request(
            "thread-follower-load-complete-history",
            { conversationId: state.threadId },
            IPC_VERSION.history,
            30_000,
          )
          .catch(() => undefined);
      }
    }
  });

  const follow = async (threadId: string): Promise<DesktopThreadState> => {
    let state = states.get(threadId);
    if (state == null) {
      state = new DesktopThreadState(threadId);
      states.set(threadId, state);
      client.broadcast(
        "thread-stream-following-changed",
        { conversationId: threadId, hostId: "local", following: true },
        IPC_VERSION.following,
      );
    }
    await state.waitFor(() => state?.ready === true, 5_000);
    return state;
  };

  const prepare: AppServerPeer["prepare"] = (method, params) =>
    Effect.sync(() => ({
      id: randomUUID(),
      method,
      serialized: JSON.stringify({ method, params }),
      reply: Deferred.unsafeMake(FiberId.none),
    }));

  const submit: AppServerPeer["submit"] = (ticket) =>
    Effect.tryPromise({
      try: async () => {
        const { method, params } = ticketPayload(ticket);
        const threadId = String(params.threadId ?? "");
        const { threadId: _, ...input } = params;
        const ipcMethod =
          method === "turn/steer"
            ? "thread-follower-steer-turn"
            : "thread-follower-start-turn";
        const ipcParams =
          method === "turn/steer"
            ? { conversationId: threadId, ...input }
            : { conversationId: threadId, turnStartParams: input };
        const response = await client.request(
          ipcMethod,
          ipcParams,
          method === "turn/steer"
            ? IPC_VERSION.steer
            : IPC_VERSION.start,
          30_000,
        );
        if (response.resultType === "error") {
          if (safeIpcRejection(response.error)) {
            throw new RpcNotWritten({
              detail:
                response.error ?? "Desktop confirmed no submission",
            });
          }
          Deferred.unsafeDone(
            ticket.reply,
            Effect.fail(
              new RpcErrorReply({
                code: -32_000,
                message: response.error ?? "Desktop rejected the request",
              }),
            ),
          );
          return;
        }
        const outer = response.result as
          | { readonly result?: unknown }
          | undefined;
        const appResult = outer?.result;
        const observedTurnId = nestedTurnId(appResult);
        if (observedTurnId != null) {
          states.get(threadId)?.observeTurn(observedTurnId);
        }
        const result =
          method === "turn/steer"
            ? {
                turnId:
                  observedTurnId ??
                  String(params.expectedTurnId ?? ""),
              }
            : appResult;
        Deferred.unsafeDone(ticket.reply, Effect.succeed(result));
      },
      catch: (cause) =>
        cause instanceof RpcNotWritten
          ? cause
          : new RpcWriteAmbiguous({
              detail:
                cause instanceof Error ? cause.message : String(cause),
            }),
    });

  const reply: AppServerPeer["reply"] = (ticket, schema, timeout) =>
    Deferred.await(ticket.reply).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new RpcTimeout({ millis: durationMillis(timeout) }),
      }),
      Effect.flatMap((value) =>
        Schema.decodeUnknown(schema)(value).pipe(
          Effect.mapError(
            (error) =>
              new RpcMalformed({ detail: String(error) }),
          ),
        ),
      ),
    );

  const request: AppServerPeer["request"] = (
    method,
    params,
    schema,
    timeout,
  ) => {
    if (method !== "thread/resume") {
      return Effect.fail(
        new RpcNotWritten({
          detail: `Desktop IPC does not support ${method}`,
        }),
      );
    }
    const threadId = String(
      (params as { readonly threadId?: unknown }).threadId ?? "",
    );
    return Effect.tryPromise({
      try: async () => {
        const state = await follow(threadId);
        return { thread: { id: threadId, turns: state.snapshot() } };
      },
      catch: (cause) =>
        new RpcNotWritten({
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new RpcTimeout({ millis: durationMillis(timeout) }),
      }),
      Effect.flatMap((value) =>
        Schema.decodeUnknown(schema)(value).pipe(
          Effect.mapError(
            (error) => new RpcMalformed({ detail: String(error) }),
          ),
        ),
      ),
    );
  };

  return {
    spec,
    serverInfo: null,
    isAlive: Effect.sync(() => client.alive),
    onNotification: (_listener, onClose) => {
      queueMicrotask(() => onClose?.());
      return () => undefined;
    },
    notify: () => Effect.void,
    prepare,
    submit,
    reply,
    request,
    awaitTurn: (turnId, timeout) =>
      Effect.tryPromise({
        try: async () => {
          const followed = [...states.values()];
          const state =
            followed.find(
              (candidate) => candidate.turn(turnId) != null,
            ) ??
            (followed.length === 1 ? followed[0] : null);
          if (state == null) {
            throw new Error("Desktop task was not followed");
          }
          await state.waitFor(
            () => {
              const turn = state.turn(turnId);
              return turn != null && turn.status !== "inProgress";
            },
            durationMillis(timeout),
          );
          const turn = state.turn(turnId);
          if (turn == null) throw new Error("Desktop turn disappeared");
          return turn;
        },
        catch: (cause) =>
          cause instanceof Error &&
          cause.message.includes("timed out")
            ? new RpcTimeout({ millis: durationMillis(timeout) })
            : new RpcDisconnected({
                detail:
                  cause instanceof Error ? cause.message : String(cause),
              }),
      }),
  };
}

export function connectDesktop(
  spec: Extract<TransportSpec, { readonly _tag: "Desktop" }>,
): Effect.Effect<
  AppServerPeer,
  TransportUnavailable | TransportIncompatible,
  Scope.Scope
> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => DesktopIpcClient.connect(spec.socketPath),
      catch: (cause) => {
        const detail =
          cause instanceof Error ? cause.message : String(cause);
        if (!(cause instanceof DesktopIpcConnectError)) {
          return new TransportIncompatible({
            transport: "desktop",
            stage: "initialize",
            detail,
          });
        }
        if (cause.failure === "socket-unavailable") {
          return new TransportUnavailable({
            transport: "desktop",
            reason: "not-running",
            detail,
          });
        }
        if (cause.failure === "socket-failed") {
          return new TransportUnavailable({
            transport: "desktop",
            reason: "connect-failed",
            detail,
          });
        }
        if (cause.failure === "initialize-timeout") {
          return new TransportUnavailable({
            transport: "desktop",
            reason: "handshake-timeout",
            detail,
          });
        }
        if (cause.failure === "initialize-failed") {
          return new TransportUnavailable({
            transport: "desktop",
            reason: "exited",
            detail,
          });
        }
        return new TransportIncompatible({
          transport: "desktop",
          stage: "malformed",
          detail,
        });
      },
    }),
    (client) => Effect.sync(() => client.close()),
  ).pipe(Effect.map((client) => makePeer(spec, client)));
}
