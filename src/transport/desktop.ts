import { randomUUID } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Deferred,
  Duration,
  Effect,
  FiberId,
  Option,
  Schema,
  Scope,
} from "effect";
import { DesktopIpcClient } from "./desktop-ipc-client.js";
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

function defaultSocketPath(): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\codex-ipc"
    : path.join(os.homedir(), ".codex", "ipc", "ipc.sock");
}

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

export async function desktopSocketIsPrivate(
  socketPath: string,
): Promise<boolean> {
  if (process.platform === "win32") return true;
  const [info, parent] = await Promise.all([
    lstat(socketPath),
    stat(path.dirname(socketPath)),
  ]);
  return (
    info.isSocket() &&
    !info.isSymbolicLink() &&
    process.getuid?.() === info.uid &&
    (info.mode & 0o077) === 0 &&
    parent.isDirectory() &&
    parent.uid === info.uid &&
    (parent.mode & 0o077) === 0
  );
}

async function probe(socketPath: string): Promise<boolean> {
  if (!(await desktopSocketIsPrivate(socketPath))) return false;
  const client = await DesktopIpcClient.connect(socketPath);
  client.close();
  return true;
}

export const desktopProbe: Effect.Effect<Option.Option<TransportSpec>> =
  Effect.promise(async () => {
    const socketPath =
      process.env.CODEXHOOK_DESKTOP_IPC_PATH ?? defaultSocketPath();
    return (await probe(socketPath))
      ? Option.some({
          _tag: "Desktop",
          id: "desktop",
          socketPath,
          coPresence: true,
          approvals: "decline",
        } as const)
      : Option.none();
  }).pipe(Effect.catchAll(() => Effect.succeed(Option.none())));

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
    isAlive: Effect.sync(() => client.alive),
    notify: () => Effect.void,
    prepare,
    submit,
    reply,
    request,
    awaitTurn: (turnId, timeout) =>
      Effect.tryPromise({
        try: async () => {
          const state = [...states.values()].find(
            (candidate) => candidate.turn(turnId) != null,
          );
          if (state == null) throw new Error("Desktop turn was not observed");
          await state.waitFor(
            () => state.turn(turnId)?.status !== "inProgress",
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
      catch: (cause) =>
        new TransportUnavailable({
          transport: "desktop",
          reason: "not-running",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
    (client) => Effect.sync(() => client.close()),
  ).pipe(Effect.map((client) => makePeer(spec, client)));
}
