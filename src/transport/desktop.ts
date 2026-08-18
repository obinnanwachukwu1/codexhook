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
  DesktopProtocolError,
  DesktopProtocolSession,
  type DesktopKnownRejection,
} from "./desktop-ipc/index.js";
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

function confirmsNoSubmission(error: DesktopKnownRejection): boolean {
  return error !== "unknown";
}

function desktopSubmitError(
  cause: unknown,
): RpcNotWritten | RpcWriteAmbiguous {
  if (cause instanceof RpcNotWritten) return cause;
  if (
    cause instanceof DesktopProtocolError &&
    cause.writeState === "not-written"
  ) {
    return new RpcNotWritten({ detail: cause.message });
  }
  return new RpcWriteAmbiguous({
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

function makePeer(
  spec: Extract<TransportSpec, { readonly _tag: "Desktop" }>,
  client: DesktopProtocolSession,
): AppServerPeer {
  const states = new Map<string, DesktopThreadState>();
  client.onObservation((observation) => {
    if (observation._tag !== "Reconnecting") return;
    for (const state of states.values()) state.reset();
  });
  client.onBroadcast((message) => {
    for (const state of states.values()) {
      state.apply(message);
      if (state.takeResyncRequest()) {
        void client
          .loadCompleteHistory(state.threadId, 30_000)
          .catch(() => undefined);
      }
    }
  });

  const follow = async (threadId: string): Promise<DesktopThreadState> => {
    let state = states.get(threadId);
    if (state == null) {
      state = new DesktopThreadState(threadId);
      states.set(threadId, state);
      try {
        await client.followThread(threadId);
      } catch (cause) {
        if (states.get(threadId) === state) states.delete(threadId);
        throw cause;
      }
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
        const response = method === "turn/steer"
          ? await client.steerTurn(threadId, input, 30_000)
          : await client.startTurn(threadId, input, 30_000);
        if (response.outcome._tag === "Rejected") {
          if (confirmsNoSubmission(response.outcome.rejection)) {
            throw new RpcNotWritten({
              detail: `Desktop confirmed no submission (${response.outcome.rejection})`,
            });
          }
          Deferred.unsafeDone(
            ticket.reply,
            Effect.fail(
              new RpcErrorReply({
                code: -32_000,
                message: "Desktop rejected the request",
              }),
            ),
          );
          return;
        }
        const observedTurnId = response.outcome.value.turnId;
        if (observedTurnId != null) {
          states.get(threadId)?.observeTurn(observedTurnId);
        }
        if (method !== "turn/steer" && observedTurnId == null) {
          throw new RpcWriteAmbiguous({
            detail: "Desktop accepted start without a turn id",
          });
        }
        const result =
          method === "turn/steer"
            ? {
                turnId:
                  observedTurnId ??
                  String(params.expectedTurnId ?? ""),
              }
            : {
                turn: {
                  id: observedTurnId,
                  status: "inProgress" as const,
                  error: null,
                },
              };
        Deferred.unsafeDone(ticket.reply, Effect.succeed(result));
      },
      catch: desktopSubmitError,
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
  return Effect.suspend(() => {
    let acquired: DesktopProtocolSession | null = null;
    const open = Effect.tryPromise({
      try: async (signal) => {
        const client = await DesktopProtocolSession.connect(
          spec.socketPath,
          {},
          signal,
        );
        acquired = client;
        return client;
      },
      catch: (cause) => {
        const detail =
          cause instanceof Error ? cause.message : String(cause);
        if (!(cause instanceof DesktopProtocolError)) {
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
        if (cause.failure === "connect-timeout") {
          return new TransportUnavailable({
            transport: "desktop",
            reason: "connect-failed",
            detail,
          });
        }
        if (cause.failure === "request-timeout") {
          return new TransportUnavailable({
            transport: "desktop",
            reason: "handshake-timeout",
            detail,
          });
        }
        if (
          cause.failure === "closed" ||
          cause.failure === "write-failed"
        ) {
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
    });
    return Effect.acquireReleaseInterruptible(
      open,
      () => Effect.sync(() => acquired?.close()),
    ).pipe(Effect.map((client) => makePeer(spec, client)));
  });
}
