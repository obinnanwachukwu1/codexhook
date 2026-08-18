import { randomUUID } from "node:crypto";
import {
  Deferred,
  Duration,
  Effect,
  FiberId,
  Schema,
  Scope,
} from "effect";
import {
  DesktopAttachment,
  DesktopNotWrittenError,
  DesktopRejectedError,
  DesktopUncertainError,
} from "./desktop-attachment.js";
import {
  DesktopIpcConnectError,
} from "./desktop-ipc-client.js";
import { DesktopIpcProtocol } from "./desktop-protocol.js";
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

function makePeer(
  spec: Extract<TransportSpec, { readonly _tag: "Desktop" }>,
  attachment: DesktopAttachment,
): AppServerPeer {
  const followedThreads = new Set<string>();
  const turnThreads = new Map<string, string>();
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
        let result;
        try {
          result = await attachment.inject({
            kind: method === "turn/steer" ? "steer" : "start",
            threadId,
            ...(method === "turn/steer"
              ? { expectedTurnId: String(params.expectedTurnId ?? "") }
              : {}),
            clientUserMessageId: String(params.clientUserMessageId ?? ""),
            input: params.input,
          });
        } catch (cause) {
          if (!(cause instanceof DesktopRejectedError)) throw cause;
          Deferred.unsafeDone(
            ticket.reply,
            Effect.fail(
              new RpcErrorReply({ code: -32_000, message: cause.message }),
            ),
          );
          return;
        }
        turnThreads.set(result.turnId, threadId);
        Deferred.unsafeDone(
          ticket.reply,
          Effect.succeed(
            method === "turn/steer"
              ? { turnId: result.turnId }
              : { turn: result.turn },
          ),
        );
      },
      catch: (cause) => {
        if (cause instanceof DesktopNotWrittenError) {
          return new RpcNotWritten({ detail: cause.message });
        }
        if (cause instanceof DesktopUncertainError) {
          return new RpcWriteAmbiguous({ detail: cause.message });
        }
        return new RpcWriteAmbiguous({
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      },
    });

  const reply: AppServerPeer["reply"] = (ticket, schema, timeout) =>
    Deferred.await(ticket.reply).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new RpcTimeout({ millis: durationMillis(timeout) }),
      }),
      Effect.flatMap((value) => Schema.decodeUnknown(schema)(value).pipe(
        Effect.mapError((error) =>
          new RpcMalformed({ detail: String(error) }),
        ),
      )),
    );

  const request: AppServerPeer["request"] = (
    method,
    params,
    schema,
    timeout,
  ) => {
    if (method !== "thread/resume") {
      return Effect.fail(new RpcNotWritten({
        detail: `Desktop IPC does not support ${method}`,
      }));
    }
    const threadId = String(
      (params as { readonly threadId?: unknown }).threadId ?? "",
    );
    return Effect.tryPromise({
      try: async () => {
        const turns = await attachment.resume(threadId);
        followedThreads.add(threadId);
        for (const turn of turns) turnThreads.set(turn.id, threadId);
        return { thread: { id: threadId, turns } };
      },
      catch: (cause) => new RpcNotWritten({
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
    }).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new RpcTimeout({ millis: durationMillis(timeout) }),
      }),
      Effect.flatMap((value) => Schema.decodeUnknown(schema)(value).pipe(
        Effect.mapError((error) =>
          new RpcMalformed({ detail: String(error) }),
        ),
      )),
    );
  };

  return {
    spec,
    isAlive: Effect.sync(() => attachment.connected),
    notify: (method, params) => {
      if (method !== "turn/interrupt") return Effect.void;
      const input = params as {
        readonly threadId?: unknown;
        readonly turnId?: unknown;
      };
      return Effect.tryPromise({
        try: () => attachment.inject({
          kind: "interrupt",
          threadId: String(input.threadId ?? ""),
          expectedTurnId: String(input.turnId ?? ""),
        }).then(() => undefined),
        catch: (cause) => cause instanceof DesktopNotWrittenError
          ? new RpcNotWritten({ detail: cause.message })
          : new RpcWriteAmbiguous({ detail: errorMessage(cause) }),
      });
    },
    prepare,
    submit,
    reply,
    request,
    awaitTurn: (turnId, timeout) => Effect.tryPromise({
        try: () => {
          const threadId = turnThreads.get(turnId) ??
            [...followedThreads].find((candidate) =>
              attachment.state(candidate).turns.some(
                (turn) => turn.id === turnId,
              ),
            ) ??
            (followedThreads.size === 1
              ? [...followedThreads][0]
              : undefined);
          if (threadId == null) {
            throw new Error("Desktop task was not followed");
          }
          return attachment.awaitTurn(
            threadId,
            turnId,
            durationMillis(timeout),
          );
        },
        catch: (cause) => errorMessage(cause).includes("timed out")
          ? new RpcTimeout({ millis: durationMillis(timeout) })
          : new RpcDisconnected({ detail: errorMessage(cause) }),
      }),
  };
}

function connectError(cause: unknown) {
  const detail = errorMessage(cause);
  if (!(cause instanceof DesktopIpcConnectError)) {
    return new TransportIncompatible({
      transport: "desktop" as const,
      stage: "initialize" as const,
      detail,
    });
  }
  if (cause.failure === "socket-unavailable") {
    return new TransportUnavailable({
      transport: "desktop" as const,
      reason: "not-running" as const,
      detail,
    });
  }
  if (cause.failure === "socket-failed") {
    return new TransportUnavailable({
      transport: "desktop" as const,
      reason: "connect-failed" as const,
      detail,
    });
  }
  if (cause.failure === "initialize-timeout") {
    return new TransportUnavailable({
      transport: "desktop" as const,
      reason: "handshake-timeout" as const,
      detail,
    });
  }
  if (cause.failure === "initialize-failed") {
    return new TransportUnavailable({
      transport: "desktop" as const,
      reason: "exited" as const,
      detail,
    });
  }
  return new TransportIncompatible({
    transport: "desktop" as const,
    stage: "malformed" as const,
    detail,
  });
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
      try: async () => {
        const protocol = await DesktopIpcProtocol.connect(spec.socketPath);
        return new DesktopAttachment(
          () => DesktopIpcProtocol.connect(spec.socketPath),
          protocol,
        );
      },
      catch: connectError,
    }),
    (attachment) => Effect.sync(() => attachment.close()),
  ).pipe(Effect.map((attachment) => makePeer(spec, attachment)));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
