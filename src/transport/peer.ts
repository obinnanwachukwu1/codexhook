import { createInterface } from "node:readline";
import {
  Deferred,
  Duration,
  Effect,
  FiberId,
  Schema,
  Scope,
} from "effect";
import { Logger } from "../logger.js";
import { TurnId } from "../types.js";
import {
  InitializeResult,
  INITIALIZE_PARAMS,
  type Turn,
} from "./protocol.js";
import {
  TransportIncompatible,
  TransportUnavailable,
} from "./errors.js";
import type { TransportSpec } from "./spec.js";
import {
  type AppServerPeer,
  RpcDisconnected,
  RpcErrorReply,
  RpcMalformed,
  RpcNotWritten,
  RpcTimeout,
  type RpcTicket,
  RpcWriteAmbiguous,
  type WireConnection,
  type WireMessage,
  type WireNotification,
} from "./rpc.js";
import { publishNotification } from "./notifications.js";

const HANDSHAKE_TIMEOUT = Duration.seconds(15);
const MAX_TURN_SLOTS = 1_000;
function durationMillis(input: Duration.DurationInput): number {
  return Duration.toMillis(Duration.decode(input));
}
export function connectWirePeer(
  spec: TransportSpec,
  connection: WireConnection,
  logger = new Logger(),
): Effect.Effect<
  AppServerPeer,
  TransportUnavailable | TransportIncompatible,
  Scope.Scope
> {
  return Effect.gen(function* () {
    let alive = true;
    let sequence = 0;
    const pending = new Map<
      string,
      Deferred.Deferred<unknown, RpcErrorReply | RpcDisconnected>
    >();
    const notificationListeners = new Set<
      (message: WireNotification) => void
    >();
    let serverInfo: typeof InitializeResult.Type | null = null;
    const turns = new Map<
      string,
      Deferred.Deferred<Turn, RpcDisconnected>
    >();
    const disconnected = yield* Deferred.make<never, RpcDisconnected>();
    const turnSlot = (
      id: string,
    ): Deferred.Deferred<Turn, RpcDisconnected> => {
      const existing = turns.get(id);
      if (existing != null) return existing;
      const created = Deferred.unsafeMake<Turn, RpcDisconnected>(FiberId.none);
      turns.set(id, created);
      while (turns.size > MAX_TURN_SLOTS) {
        const oldest = turns.keys().next().value as string | undefined;
        if (oldest == null) break;
        turns.delete(oldest);
      }
      return created;
    };
    const down = (detail: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (!alive) return Effect.void;
        alive = false;
        const failure = new RpcDisconnected({ detail });
        const pendingWaiters = [...pending.values()];
        const turnWaiters = [...turns.values()];
        pending.clear();
        turns.clear();
        return Deferred.fail(disconnected, failure).pipe(
          Effect.zipRight(
            Effect.forEach(
              pendingWaiters,
              (waiter) => Deferred.fail(waiter, failure),
              { discard: true },
            ),
          ),
          Effect.zipRight(
            Effect.forEach(
              turnWaiters,
              (waiter) => Deferred.fail(waiter, failure),
              { discard: true },
            ),
          ),
        );
      });
    const writeSerialized = (
      serialized: string,
    ): Effect.Effect<void, RpcNotWritten | RpcWriteAmbiguous> =>
      Effect.suspend(
        (): Effect.Effect<
          void,
          RpcNotWritten | RpcWriteAmbiguous
        > => {
        if (!alive || !connection.isAlive()) {
          return Effect.fail(
            new RpcNotWritten({ detail: "app-server is not connected" }),
          );
        }
        return Effect.async<void, RpcWriteAmbiguous>((resume) => {
          try {
            connection.write(serialized, (error) => {
              if (error != null) {
                resume(
                  Effect.fail(
                    new RpcWriteAmbiguous({ detail: error.message }),
                  ),
                );
              } else {
                resume(Effect.void);
              }
            });
          } catch (cause) {
            // Once write() is invoked, be conservative: partial submission is possible.
            resume(
              Effect.fail(
                new RpcWriteAmbiguous({ detail: String(cause) }),
              ),
            );
          }
        }).pipe(
          Effect.raceFirst(
            Deferred.await(disconnected).pipe(
              Effect.mapError(
                (error) =>
                  new RpcWriteAmbiguous({ detail: error.detail }),
              ),
            ),
          ),
        );
      },
      );
    const writeWire = (
      message: WireMessage,
    ): Effect.Effect<void, RpcNotWritten | RpcWriteAmbiguous> =>
      Effect.try({
        try: () => `${JSON.stringify(message)}\n`,
        catch: (cause) => new RpcNotWritten({ detail: String(cause) }),
      }).pipe(Effect.flatMap(writeSerialized));
    const prepare: AppServerPeer["prepare"] = (method, params) =>
      Effect.suspend(() => {
        if (!alive || !connection.isAlive()) {
          return Effect.fail(
            new RpcNotWritten({ detail: "app-server is not connected" }),
          );
        }
        const id = `codexhook-${++sequence}`;
        const reply = Deferred.unsafeMake<
          unknown,
          RpcErrorReply | RpcDisconnected
        >(FiberId.none);
        try {
          const serialized = `${JSON.stringify({ id, method, params })}\n`;
          const ticket = { id, method, serialized, reply } satisfies RpcTicket;
          pending.set(id, reply);
          return Effect.succeed(ticket);
        } catch (cause) {
          return Effect.fail(new RpcNotWritten({ detail: String(cause) }));
        }
      });
    const submit: AppServerPeer["submit"] = (ticket) =>
      writeSerialized(ticket.serialized).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            pending.delete(ticket.id);
          }),
        ),
      );
    const reply: AppServerPeer["reply"] = (ticket, schema, timeout) =>
      Deferred.await(ticket.reply).pipe(
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            new RpcTimeout({ millis: durationMillis(timeout) }),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(ticket.id);
          }),
        ),
        Effect.flatMap((raw) =>
          Schema.decodeUnknown(schema)(raw).pipe(
            Effect.mapError(
              (error) => new RpcMalformed({ detail: error.message }),
            ),
          ),
        ),
      );
    const request: AppServerPeer["request"] = (
      method,
      params,
      schema,
      timeout,
    ) =>
      prepare(method, params).pipe(
        Effect.tap(submit),
        Effect.flatMap((ticket) => reply(ticket, schema, timeout)),
      );

    const notify: AppServerPeer["notify"] = (method, params) =>
      writeWire({ method, params });
    const respondToServerRequest = (
      id: string | number,
      method: string,
    ): Effect.Effect<void, RpcNotWritten | RpcWriteAmbiguous> => {
      const knownApproval =
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "exec/requestApproval" ||
        method === "patch/requestApproval";
      logger.warn("app_server_interaction_declined", {
        method,
        transport: spec.id,
      });
      return knownApproval
        ? writeWire({ id, result: { decision: "decline" } })
        : writeWire({
            id,
            error: { code: -32601, message: `unsupported: ${method}` },
          });
    };

    const handleLine = (line: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        let message: WireMessage;
        try {
          message = JSON.parse(line) as WireMessage;
        } catch {
          logger.warn("app_server_invalid_json", {
            transport: spec.id,
            message: line.slice(0, 500),
          });
          return Effect.void;
        }

        if (message.id != null && message.method == null) {
          const waiter = pending.get(String(message.id));
          if (waiter == null) return Effect.void;
          pending.delete(String(message.id));
          return message.error == null
            ? Deferred.succeed(waiter, message.result)
            : Deferred.fail(
                waiter,
                new RpcErrorReply({
                  code: message.error.code ?? -32_000,
                  message: message.error.message ?? "app-server request failed",
                }),
              );
        }
        if (message.id != null && message.method != null) {
          return respondToServerRequest(message.id, message.method).pipe(
            Effect.catchAll(() => Effect.void),
          );
        }
        if (message.method != null) {
          publishNotification(
            notificationListeners,
            { method: message.method, params: message.params },
            logger,
          );
        }
        if (message.method === "turn/completed") {
          const params = message.params as { turn?: Turn } | undefined;
          if (params?.turn != null) {
            return Deferred.succeed(
              turnSlot(params.turn.id),
              params.turn,
            ).pipe(Effect.asVoid);
          }
        }
        return Effect.void;
      });
    const readline = createInterface({ input: connection.input });
    readline.on("line", (line) => {
      Effect.runFork(handleLine(line));
    });
    connection.onStderr?.((chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length > 0) {
          logger.warn("app_server_stderr", {
            transport: spec.id,
            message: line.slice(0, 2_000),
          });
        }
      }
    });
    connection.onError((error) => {
      Effect.runFork(down(`spawn error: ${error.message}`));
    });
    connection.onExit((code, signal) => {
      Effect.runFork(
        down(`exited code=${String(code)} signal=${String(signal)}`),
      );
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        alive = false;
        readline.close();
      }),
    );

    const peer: AppServerPeer = {
      spec,
      get serverInfo() {
        return serverInfo;
      },
      isAlive: Effect.sync(() => alive && connection.isAlive()),
      onNotification: (listener) => {
        notificationListeners.add(listener);
        return () => notificationListeners.delete(listener);
      },
      notify,
      prepare,
      submit,
      reply,
      request,
      awaitTurn: (turnId, timeout) =>
        Deferred.await(turnSlot(turnId)).pipe(
          Effect.timeoutFail({
            duration: timeout,
            onTimeout: () =>
              new RpcTimeout({ millis: durationMillis(timeout) }),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              turns.delete(turnId);
            }),
          ),
        ),
    };

    serverInfo = yield* peer
      .request(
        "initialize",
        INITIALIZE_PARAMS,
        InitializeResult,
        HANDSHAKE_TIMEOUT,
      )
      .pipe(
        Effect.mapError((error) => {
          if (error._tag === "RpcTimeout") {
            return new TransportUnavailable({
              transport: spec.id,
              reason: "handshake-timeout",
              detail: "initialize timed out",
            });
          }
          if (
            error._tag === "RpcMalformed" ||
            error._tag === "RpcErrorReply"
          ) {
            return new TransportIncompatible({
              transport: spec.id,
              stage: "initialize",
              detail:
                error._tag === "RpcMalformed"
                  ? error.detail
                  : error.message,
            });
          }
          return new TransportUnavailable({
            transport: spec.id,
            reason: "exited",
            detail: error.detail,
          });
        }),
      );
    yield* peer.notify("initialized", {}).pipe(
      Effect.mapError(
        (error) =>
          new TransportUnavailable({
            transport: spec.id,
            reason: "exited",
            detail: error.detail,
          }),
      ),
    );
    return peer;
  });
}
