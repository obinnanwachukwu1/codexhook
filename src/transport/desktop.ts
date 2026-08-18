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
} from "./desktop-attachment.js";
import { desktopOutcomeDetail } from "./desktop-injection.js";
import {
  desktopErrorMessage,
  DesktopTimeoutError,
} from "./desktop-errors.js";
import {
  DesktopIpcConnectError,
} from "./desktop-ipc-client.js";
import { DesktopIpcProtocol } from "./desktop-task-protocol.js";
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
        const deliveryId = String(params.clientUserMessageId ?? "");
        const result = await attachment.inject(method === "turn/steer"
          ? {
              kind: "steer",
              threadId,
              expectedTurnId: String(params.expectedTurnId ?? ""),
              clientUserMessageId: deliveryId,
              input: params.input,
            }
          : {
              kind: "start",
              threadId,
              clientUserMessageId: deliveryId,
              input: params.input,
            });
        if (result._tag === "NotSubmitted") {
          throw new RpcNotWritten({ detail: desktopOutcomeDetail(result) });
        }
        if (result._tag === "Ambiguous") {
          throw new RpcWriteAmbiguous({ detail: desktopOutcomeDetail(result) });
        }
        if (result._tag === "Rejected") {
          Deferred.unsafeDone(
            ticket.reply,
            Effect.fail(
              new RpcErrorReply({
                code: -32_000,
                message: desktopOutcomeDetail(result),
              }),
            ),
          );
          return;
        }
        Deferred.unsafeDone(
          ticket.reply,
          Effect.succeed(
            method === "turn/steer"
              ? { turnId: result.turnId }
              : { turn: result.turn },
          ),
        );
      },
      catch: (cause) => cause instanceof RpcNotWritten ||
          cause instanceof RpcWriteAmbiguous
        ? cause
        : new RpcWriteAmbiguous({ detail: desktopErrorMessage(cause) }),
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
        return { thread: { id: threadId, turns } };
      },
      catch: (cause) => new RpcNotWritten({
        detail: desktopErrorMessage(cause),
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
    notify: () => Effect.void,
    prepare,
    submit,
    reply,
    request,
    awaitTurn: (threadId, turnId, timeout) => Effect.tryPromise({
        try: () => attachment.awaitTurn(
          threadId,
          turnId,
          durationMillis(timeout),
        ),
        catch: (cause) => cause instanceof DesktopTimeoutError
          ? new RpcTimeout({ millis: durationMillis(timeout) })
          : new RpcDisconnected({ detail: desktopErrorMessage(cause) }),
      }),
  };
}

function connectError(cause: unknown) {
  const detail = desktopErrorMessage(cause);
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
