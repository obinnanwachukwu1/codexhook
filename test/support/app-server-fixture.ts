import { Deferred, Effect, FiberId, Schema } from "effect";
import type { AppServerPeer } from "../../src/transport/rpc.js";
import {
  RpcDisconnected,
  RpcErrorReply,
  RpcMalformed,
  RpcNotWritten,
  RpcTimeout,
  RpcWriteAmbiguous,
  type WireNotification,
} from "../../src/transport/rpc.js";
import type { TransportSpec } from "../../src/transport/spec.js";

export interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

export interface FakeAppServerPeer {
  readonly peer: AppServerPeer;
  readonly requests: RecordedRequest[];
  readonly submissions: string[];
  emit(message: WireNotification): void;
  close(): void;
  setAlive(alive: boolean): void;
}

export type AppServerHandler = (
  method: string,
  params: unknown,
) => unknown;

export function canonicalTurn(
  id: string,
  items: ReadonlyArray<unknown> = [],
  itemsView = "full",
) {
  return {
    id,
    items,
    itemsView,
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

export function canonicalThread(
  id: string,
  source: unknown,
  updatedAt = 1,
) {
  return {
    id,
    preview: `preview ${id}`,
    ephemeral: false,
    createdAt: 1,
    updatedAt,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "0.147.0",
    source,
    canAcceptDirectInput: true,
    name: null,
    turns: [],
  };
}

export function fakeAppServerPeer(
  handler: AppServerHandler,
  options: {
    readonly spec?: TransportSpec;
    readonly prepareFailure?: boolean;
    readonly submitFailure?: "not-written" | "ambiguous";
    readonly replyFailure?:
      | "rejected"
      | "timeout"
      | "disconnected"
      | "malformed"
      | "interrupted"
      | "defect";
    readonly replyNever?: boolean;
    readonly serverInfo?: AppServerPeer["serverInfo"];
  } = {},
): FakeAppServerPeer {
  const requests: RecordedRequest[] = [];
  const submissions: string[] = [];
  const listeners = new Set<(message: WireNotification) => void>();
  const closeListeners = new Map<
    (message: WireNotification) => void,
    () => void
  >();
  let alive = true;
  let sequence = 0;
  const peer: AppServerPeer = {
    spec: options.spec ?? {
      _tag: "ChildProcess",
      id: "cli",
      executable: "/usr/bin/codex",
      args: [],
      approvals: "decline",
    },
    serverInfo: options.serverInfo === undefined
      ? {
          userAgent: "codex_cli_rs/0.147.0",
          codexHome: "/home/user/.codex",
          platformFamily: "unix",
          platformOs: "linux",
        }
      : options.serverInfo,
    isAlive: Effect.sync(() => alive),
    onNotification: (listener, onClose = () => undefined) => {
      listeners.add(listener);
      closeListeners.set(listener, onClose);
      return () => {
        listeners.delete(listener);
        closeListeners.delete(listener);
      };
    },
    notify: () => Effect.void,
    prepare: (method, params) => {
      if (options.prepareFailure) {
        return Effect.fail(new RpcNotWritten({ detail: "not connected" }));
      }
      requests.push({ method, params });
      return Effect.succeed({
        id: `fake-${++sequence}`,
        method,
        serialized: JSON.stringify({ method, params }),
        reply: Deferred.unsafeMake(FiberId.none),
      });
    },
    submit: (ticket) => {
      submissions.push(ticket.method);
      if (options.submitFailure === "not-written") {
        return Effect.fail(new RpcNotWritten({ detail: "closed before write" }));
      }
      if (options.submitFailure === "ambiguous") {
        return Effect.fail(new RpcWriteAmbiguous({ detail: "closed after write" }));
      }
      return Effect.void;
    },
    reply: <A, I>(ticket: { readonly method: string }, schema: Schema.Schema<A, I>) => {
      if (options.replyNever) return Effect.never;
      switch (options.replyFailure) {
        case "rejected":
          return Effect.fail(new RpcErrorReply({ code: -32602, message: "rejected" }));
        case "timeout":
          return Effect.fail(new RpcTimeout({ millis: 30_000 }));
        case "disconnected":
          return Effect.fail(new RpcDisconnected({ detail: "closed" }));
        case "malformed":
          return Effect.fail(new RpcMalformed({ detail: "bad reply" }));
        case "interrupted":
          return Effect.interrupt;
        case "defect":
          return Effect.die("reply defect");
      }
      const request = requests.findLast((entry) => entry.method === ticket.method);
      return decode(schema, handler(ticket.method, request?.params));
    },
    request: <A, I>(method: string, params: unknown, schema: Schema.Schema<A, I>) => {
      requests.push({ method, params });
      return decode(schema, handler(method, params));
    },
    awaitTurn: (turnId) => Effect.succeed({ id: turnId, status: "completed" }),
  };
  return {
    peer,
    requests,
    submissions,
    emit: (message) => {
      const snapshot = [...listeners];
      queueMicrotask(() => {
        for (const listener of snapshot) {
          if (listeners.has(listener)) listener(message);
        }
      });
    },
    close: () => {
      if (!alive) return;
      alive = false;
      const snapshot = [...closeListeners.values()];
      listeners.clear();
      closeListeners.clear();
      queueMicrotask(() => {
        for (const listener of snapshot) listener();
      });
    },
    setAlive: (value) => {
      alive = value;
    },
  };
}

function decode<A, I>(schema: Schema.Schema<A, I>, value: unknown) {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((error) => new RpcMalformed({ detail: error.message })),
  );
}
