import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { Logger } from "../logger.js";
import type {
  DeliveryId,
  ThreadId,
  TransportId,
  TurnId,
  TurnOutcome,
  TurnRequest,
} from "../types.js";
import { TurnId as makeTurnId } from "../types.js";
import {
  type DeliveryError,
  SubmitAmbiguous,
  SubmitRejected,
  ThreadBusy,
  ThreadUnavailable,
  TransportIncompatible,
  TransportUnavailable,
  TurnAbandoned,
  TurnFailed,
  TurnTimeout,
} from "./errors.js";
import { confirmDesktopVisibility } from "./desktop-visibility.js";
import {
  deliverWithFallback,
  type TransportAttemptStage,
} from "./attempts.js";
import type {
  AppServerPeer,
  RpcErrorReply,
  RpcMalformed,
  RpcNotWritten,
  RpcTimeout,
  RpcWriteAmbiguous,
} from "./rpc.js";
import {
  ThreadResumeResult,
  type ThreadResumeResult as ThreadResumeResultType,
  type Turn,
  TurnStartResult,
  TurnSteerResult,
} from "./protocol.js";
import { TransportProvider } from "./provider.js";
import type { TransportSpec } from "./spec.js";

const RPC_TIMEOUT = Duration.seconds(30);

export interface TransportStatus {
  readonly candidates: ReadonlyArray<TransportId>;
  readonly desktopIpcAvailable: boolean;
}

export interface CodexTransportService {
  readonly deliver: (
    request: TurnRequest,
  ) => Effect.Effect<TurnOutcome, DeliveryError>;
  readonly status: Effect.Effect<TransportStatus>;
}

export class CodexTransport extends Context.Tag("codexhook/CodexTransport")<
  CodexTransport,
  CodexTransportService
>() {}

function millis(input: Duration.DurationInput): number {
  return Duration.toMillis(Duration.decode(input));
}

function activeTurn(result: ThreadResumeResultType): Option.Option<Turn> {
  return Option.fromNullable(
    [...result.thread.turns]
      .reverse()
      .find((turn) => turn.status === "inProgress"),
  );
}

function preSubmitUnavailable(
  transport: TransportId,
  error: RpcNotWritten,
): TransportUnavailable {
  return new TransportUnavailable({
    transport,
    reason: "exited",
    detail: error.detail,
  });
}

function ambiguous(
  spec: TransportSpec,
  request: TurnRequest,
  method: "turn/start" | "turn/steer",
  error:
    | RpcWriteAmbiguous
    | RpcMalformed
    | RpcTimeout
    | { readonly _tag: "RpcDisconnected"; readonly detail: string },
): SubmitAmbiguous {
  const cause =
    error._tag === "RpcTimeout"
      ? "timeout"
      : error._tag === "RpcMalformed"
        ? "malformed"
        : error._tag === "RpcWriteAmbiguous"
          ? "write-error"
          : "disconnected";
  return new SubmitAmbiguous({
    transport: spec.id,
    method,
    threadId: request.threadId,
    deliveryId: request.deliveryId,
    cause,
  });
}

function submit<A, I>(
  peer: AppServerPeer,
  spec: TransportSpec,
  request: TurnRequest,
  method: "turn/start" | "turn/steer",
  params: unknown,
  schema: Schema.Schema<A, I>,
  turnId: (result: A) => string,
): Effect.Effect<
  { readonly turnId: TurnId },
  TransportUnavailable | SubmitRejected | SubmitAmbiguous
> {
  return peer.prepare(method, params).pipe(
    Effect.mapError((error) => preSubmitUnavailable(spec.id, error)),
    Effect.flatMap((ticket) =>
      peer.submit(ticket).pipe(
        Effect.mapError((error) =>
          error._tag === "RpcNotWritten"
            ? preSubmitUnavailable(spec.id, error)
            : ambiguous(spec, request, method, error),
        ),
        Effect.zipRight(
          peer.reply(ticket, schema, RPC_TIMEOUT).pipe(
            Effect.mapError((error) =>
              error._tag === "RpcErrorReply"
                ? new SubmitRejected({
                    transport: spec.id,
                    method,
                    code: error.code,
                    message: error.message,
                  })
                : ambiguous(spec, request, method, error),
            ),
          ),
        ),
      ),
    ),
    Effect.map((result) => ({
      turnId: makeTurnId(turnId(result)),
    })),
  );
}

function resume(
  peer: AppServerPeer,
  spec: TransportSpec,
  threadId: ThreadId,
): Effect.Effect<
  ThreadResumeResultType,
  TransportUnavailable | TransportIncompatible | ThreadUnavailable
> {
  return peer
    .request(
      "thread/resume",
      { threadId },
      ThreadResumeResult,
      RPC_TIMEOUT,
    )
    .pipe(
      Effect.mapError((error) => {
        if (error._tag === "RpcErrorReply") {
          return new ThreadUnavailable({
            threadId,
            detail: error.message,
          });
        }
        if (error._tag === "RpcMalformed") {
          return new TransportIncompatible({
            transport: spec.id,
            stage: "malformed",
            detail: error.detail,
          });
        }
        return new TransportUnavailable({
          transport: spec.id,
          reason:
            error._tag === "RpcTimeout"
              ? "handshake-timeout"
              : "exited",
          detail:
            "detail" in error ? String(error.detail) : "resume timed out",
        });
      }),
    );
}

function runTurn(
  peer: AppServerPeer,
  spec: TransportSpec,
  request: TurnRequest,
  setStage: (stage: TransportAttemptStage) => void,
): Effect.Effect<
  TurnOutcome,
  | TransportUnavailable
  | TransportIncompatible
  | ThreadUnavailable
  | ThreadBusy
  | SubmitRejected
  | SubmitAmbiguous
  | TurnAbandoned
  | TurnFailed
  | TurnTimeout
> {
  return Effect.gen(function* () {
    setStage(spec._tag === "Desktop" ? "follow" : "resume");
    const thread = yield* resume(peer, spec, request.threadId);
    const active = activeTurn(thread);

    if (request.mode === "steer" && Option.isSome(active)) {
      const turnId = makeTurnId(active.value.id);
      setStage("submit");
      yield* submit(
        peer,
        spec,
        request,
        "turn/steer",
        {
          threadId: request.threadId,
          expectedTurnId: turnId,
          clientUserMessageId: request.deliveryId,
          input: [{ type: "text", text: request.message }],
        },
        TurnSteerResult,
        (result) => result.turnId,
      );
      return {
        _tag: "Steered",
        threadId: request.threadId,
        turnId,
        transport: spec.id,
      } as const;
    }

    if (Option.isSome(active)) {
      const heldTurnId = makeTurnId(active.value.id);
      setStage("await");
      yield* peer.awaitTurn(heldTurnId, request.idleTimeout).pipe(
        Effect.mapError((error) =>
          error._tag === "RpcTimeout"
            ? new ThreadBusy({
                threadId: request.threadId,
                heldTurnId: Option.some(heldTurnId),
                waitedMillis: millis(request.idleTimeout),
              })
            : new TransportUnavailable({
                transport: spec.id,
                reason: "exited",
                detail: error.detail,
              }),
        ),
      );
    }

    setStage("submit");
    const started = yield* submit(
      peer,
      spec,
      request,
      "turn/start",
      {
        threadId: request.threadId,
        clientUserMessageId: request.deliveryId,
        input: [{ type: "text", text: request.message }],
      },
      TurnStartResult,
      (result) => result.turn.id,
    );
    setStage("await");
    const completed = yield* peer
      .awaitTurn(started.turnId, request.turnTimeout)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "RpcTimeout"
            ? new TurnTimeout({
                threadId: request.threadId,
                turnId: started.turnId,
                waitedMillis: millis(request.turnTimeout),
              })
            : new TurnAbandoned({
                threadId: request.threadId,
                turnId: started.turnId,
                detail: error.detail,
              }),
        ),
      );
    if (completed.status !== "completed") {
      return yield* new TurnFailed({
        threadId: request.threadId,
        turnId: started.turnId,
        status:
          completed.status === "interrupted" ? "interrupted" : "failed",
        message: Option.fromNullable(completed.error?.message),
      });
    }
    return {
      _tag: "Completed",
      threadId: request.threadId,
      turnId: started.turnId,
      transport: spec.id,
    } as const;
  });
}

export function makeCodexTransportLive(
  logger = new Logger(),
): Layer.Layer<
  CodexTransport,
  never,
  TransportProvider
> {
  return Layer.effect(
    CodexTransport,
    Effect.gen(function* () {
      const provider = yield* TransportProvider;
      const deliver = (
        request: TurnRequest,
      ): Effect.Effect<TurnOutcome, DeliveryError> =>
        provider.candidates.pipe(
          Effect.flatMap((candidates) =>
            deliverWithFallback(
              request,
              candidates,
              {
                run: (candidate, setStage) =>
                  Effect.scoped(
                    provider.connect(candidate).pipe(
                      Effect.flatMap((peer) =>
                        runTurn(peer, candidate, request, setStage),
                      ),
                    ),
                  ),
                confirmDesktopVisibility: (
                  desktop,
                  outcome,
                  setStage,
                ) => {
                  setStage("refresh");
                  return outcome.transport === "desktop"
                    ? Effect.succeed("confirmed" as const)
                    : confirmDesktopVisibility(
                        provider,
                        desktop,
                        outcome,
                      );
                },
              },
              logger,
            ),
          ),
        );

      const status = Effect.gen(function* () {
        const candidates = yield* provider.candidates;
        return {
          candidates: candidates.map((candidate) => candidate.id),
          desktopIpcAvailable: candidates.some(
            (candidate) => candidate._tag === "Desktop",
          ),
        } satisfies TransportStatus;
      });

      return CodexTransport.of({ deliver, status });
    }),
  );
}

export const CodexTransportLive = makeCodexTransportLive();
