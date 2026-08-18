import { Deferred, Effect, FiberId, Schema } from "effect";
import type { TransportSpec } from "../../src/transport/spec.js";
import {
  type AppServerPeer,
  RpcDisconnected,
  RpcErrorReply,
  RpcNotWritten,
  RpcTimeout,
  RpcWriteAmbiguous,
} from "../../src/transport/rpc.js";

export type WriteBehavior =
  | "ok"
  | "active-ok"
  | "before-write"
  | "connect-fail"
  | "connect-handshake-fail"
  | "ambiguous"
  | "rejected"
  | "follow-fail"
  | "follow-fail-then-absent"
  | "follow-fail-then-visible"
  | "follow-fail-then-close"
  | "follow-fail-then-disconnect-refresh"
  | "turn-timeout"
  | "turn-abandoned"
  | "busy";

export interface PeerRecorder {
  readonly writes: Array<{ transport: string; method: string }>;
  completedTurnId: string | null;
}

export function fakeTransportPeer(
  spec: TransportSpec,
  behavior: WriteBehavior,
  recorder: PeerRecorder,
  connectionOrdinal: number,
): AppServerPeer {
  let alive = true;
  let sequence = 0;
  return {
    spec,
    isAlive: Effect.sync(() => alive),
    notify: () => Effect.void,
    prepare: (method) =>
      Effect.sync(() => ({
        id: `fake-${++sequence}`,
        method,
        serialized: "{}\n",
        reply: Deferred.unsafeMake(FiberId.none),
      })),
    submit: (ticket) => {
      if (behavior === "before-write") {
        alive = false;
        return Effect.fail(new RpcNotWritten({ detail: "closed before write" }));
      }
      if (behavior === "ambiguous") {
        alive = false;
        recorder.writes.push({ transport: spec.id, method: ticket.method });
        return Effect.fail(
          new RpcWriteAmbiguous({ detail: "closed after write" }),
        );
      }
      recorder.writes.push({ transport: spec.id, method: ticket.method });
      return Effect.void;
    },
    reply: <A, I>(
      ticket: { readonly method: string },
      _schema: Schema.Schema<A, I>,
    ): Effect.Effect<A, RpcErrorReply> =>
      behavior === "rejected"
        ? Effect.fail(new RpcErrorReply({ code: -32_000, message: "rejected" }))
        : Effect.succeed(
            (ticket.method === "turn/steer"
              ? { turnId: "turn-1" }
              : { turn: { id: "turn-1", status: "inProgress" } }) as A,
          ),
    request: <A, I>(
      method: string,
      _params: unknown,
      _schema: Schema.Schema<A, I>,
    ) => {
      const disconnectsDuringRefresh =
        spec.id === "desktop" &&
        method === "thread/resume" &&
        behavior === "follow-fail-then-disconnect-refresh" &&
        connectionOrdinal === 2;
      if (disconnectsDuringRefresh) {
        alive = false;
        return Effect.fail(
          new RpcNotWritten({ detail: "Desktop closed during refresh" }),
        );
      }
      const followFails =
        spec.id === "desktop" &&
        method === "thread/resume" &&
        (behavior === "follow-fail" ||
          (behavior === "follow-fail-then-absent" &&
            connectionOrdinal === 1) ||
          behavior === "follow-fail-then-close" ||
          (behavior === "follow-fail-then-disconnect-refresh" &&
            connectionOrdinal === 1) ||
          (behavior === "follow-fail-then-visible" &&
            connectionOrdinal === 1));
      if (followFails) {
        return Effect.fail(
          new RpcNotWritten({ detail: "Desktop thread state timed out" }),
        );
      }
      const omitsFallbackTurn =
        behavior === "follow-fail-then-absent" &&
        spec.id === "desktop" &&
        connectionOrdinal === 2;
      const turns =
        spec.id === "desktop" &&
          recorder.completedTurnId != null &&
          !omitsFallbackTurn
        ? [{ id: recorder.completedTurnId, status: "completed" as const }]
        : behavior === "active-ok" || behavior === "busy"
          ? [{ id: "turn-active", status: "inProgress" as const }]
          : [];
      return Effect.succeed(
        (method === "thread/resume"
          ? { thread: { id: "thread-1", turns } }
          : {}) as A,
      );
    },
    awaitTurn: (turnId) => {
      if (behavior === "busy" && turnId === "turn-active") {
        return Effect.fail(new RpcTimeout({ millis: 1_000 }));
      }
      if (behavior === "turn-timeout" && turnId === "turn-1") {
        return Effect.fail(new RpcTimeout({ millis: 1_000 }));
      }
      if (behavior === "turn-abandoned" && turnId === "turn-1") {
        return Effect.fail(new RpcDisconnected({ detail: "disconnected" }));
      }
      if (
        behavior === "follow-fail-then-absent" &&
        spec.id === "desktop" &&
        connectionOrdinal === 2
      ) {
        return Effect.fail(new RpcTimeout({ millis: 1_000 }));
      }
      return Effect.sync(() => {
        if (turnId === "turn-active") {
          recorder.writes.push({
            transport: spec.id,
            method: `await/${turnId}`,
          });
        } else {
          recorder.completedTurnId = turnId;
        }
        return { id: turnId, status: "completed" as const };
      });
    },
  };
}
