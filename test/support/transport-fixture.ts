import { Writable } from "node:stream";
import {
  Deferred,
  Effect,
  FiberId,
  Layer,
  Option,
  Schema,
} from "effect";
import { Logger } from "../../src/logger.js";
import type { DiagnosticEvent } from "../../src/diagnostics/contracts.js";
import {
  DeliveryId,
  ThreadId,
  type TurnRequest,
} from "../../src/types.js";
import { TransportUnavailable } from "../../src/transport/errors.js";
import {
  type AppServerPeer,
  RpcNotWritten,
  RpcWriteAmbiguous,
} from "../../src/transport/rpc.js";
import {
  TransportProvider,
  type TransportProviderService,
} from "../../src/transport/provider.js";
import type { TransportSpec } from "../../src/transport/spec.js";
import {
  CodexTransport,
  makeCodexTransportLive,
} from "../../src/transport/transport.js";

export type WriteBehavior =
  | "ok"
  | "active-ok"
  | "before-write"
  | "connect-fail"
  | "connect-handshake-fail"
  | "ambiguous"
  | "follow-fail"
  | "follow-fail-then-visible"
  | "follow-fail-then-close"
  | "follow-fail-then-disconnect-refresh";

export interface Recorder {
  readonly diagnostics: DiagnosticEvent[];
  readonly logs: Array<Record<string, unknown>>;
  readonly opens: string[];
  readonly writes: Array<{ transport: string; method: string }>;
  completedTurnId: string | null;
  live: number;
  maxLive: number;
}

export interface TransportFixture {
  readonly layer: Layer.Layer<TransportProvider>;
  readonly logger: Logger;
  readonly recorder: Recorder;
}

const bundled: TransportSpec = {
  _tag: "ChildProcess",
  id: "app-bundled",
  executable: "/fake/bundled",
  args: [],
  approvals: "decline",
};

const cli: TransportSpec = {
  _tag: "ChildProcess",
  id: "cli",
  executable: "/fake/cli",
  args: [],
  approvals: "decline",
};

export const desktop: Extract<
  TransportSpec,
  { readonly _tag: "Desktop" }
> = {
  _tag: "Desktop",
  id: "desktop",
  socketPath: "/fake/ipc.sock",
  approvals: "decline",
};

export const daemon: TransportSpec = {
  _tag: "UnixSocket",
  id: "daemon",
  socketPath: "/fake/app-server.sock",
  approvals: "decline",
};

function fakePeer(
  spec: TransportSpec,
  behavior: WriteBehavior,
  recorder: Recorder,
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
        return Effect.fail(
          new RpcNotWritten({ detail: "closed before write" }),
        );
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
    ): Effect.Effect<A, never> =>
      Effect.succeed(
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
      const turns =
        spec.id === "desktop" && recorder.completedTurnId != null
          ? [{
              id: recorder.completedTurnId,
              status: "completed" as const,
            }]
          : behavior === "active-ok"
            ? [{ id: "turn-active", status: "inProgress" as const }]
            : [];
      return Effect.succeed(
        (method === "thread/resume"
          ? { thread: { id: "thread-1", turns } }
          : {}) as A,
      );
    },
    awaitTurn: (turnId) =>
      Effect.sync(() => {
        if (turnId === "turn-active") {
          recorder.writes.push({
            transport: spec.id,
            method: `await/${turnId}`,
          });
        } else {
          recorder.completedTurnId = turnId;
        }
        return { id: turnId, status: "completed" as const };
      }),
  };
}

export function fakeProvider(
  scripts: Readonly<Record<string, WriteBehavior>>,
  candidates: ReadonlyArray<TransportSpec> = [bundled, cli],
): TransportFixture {
  const recorder: Recorder = {
    diagnostics: [],
    logs: [],
    opens: [],
    writes: [],
    completedTurnId: null,
    live: 0,
    maxLive: 0,
  };
  const logger = new Logger(
    new Writable({
      write(chunk, _encoding, callback) {
        recorder.logs.push(JSON.parse(String(chunk)));
        callback();
      },
    }),
  );
  const service: TransportProviderService = {
    candidates: Effect.succeed(candidates),
    desktopCandidate: Effect.sync(() => {
      const behavior = scripts.desktop;
      const known =
        behavior != null ||
        candidates.some((candidate) => candidate._tag === "Desktop");
      const closed =
        behavior === "connect-fail" ||
        (behavior === "follow-fail-then-close" &&
          recorder.opens.includes("desktop"));
      return known && !closed
        ? Option.some(desktop)
        : Option.none();
    }),
    connect: (spec) => {
      const behavior = scripts[spec.id];
      const closedAfterFirstConnection =
        behavior === "follow-fail-then-close" &&
        recorder.opens.includes(spec.id);
      if (behavior === "connect-handshake-fail") {
        return Effect.fail(
          new TransportUnavailable({
            transport: spec.id,
            reason: "handshake-timeout",
            detail: "Desktop initialize timed out",
          }),
        );
      }
      if (behavior === "connect-fail" || closedAfterFirstConnection) {
        return Effect.fail(
          new TransportUnavailable({
            transport: spec.id,
            reason: "not-running",
            detail: "Desktop closed after discovery",
          }),
        );
      }
      return Effect.acquireRelease(
        Effect.sync(() => {
          recorder.opens.push(spec.id);
          recorder.live += 1;
          recorder.maxLive = Math.max(recorder.maxLive, recorder.live);
          const ordinal = recorder.opens.filter(
            (opened) => opened === spec.id,
          ).length;
          return fakePeer(
            spec,
            scripts[spec.id] ?? "ok",
            recorder,
            ordinal,
          );
        }),
        () =>
          Effect.sync(() => {
            recorder.live -= 1;
          }),
      );
    },
  };
  return {
    layer: Layer.succeed(TransportProvider, service),
    logger,
    recorder,
  };
}

function request(mode: "queue" | "steer"): TurnRequest {
  return {
    threadId: ThreadId("thread-1"),
    deliveryId: DeliveryId("delivery-1"),
    message: "hello",
    mode,
    idleTimeout: "1 second",
    turnTimeout: "1 second",
  };
}

function delivery(fixture: TransportFixture, mode: "queue" | "steer") {
  return Effect.scoped(
    Effect.flatMap(CodexTransport, (transport) =>
      transport.deliver(request(mode)),
    ).pipe(
      Effect.provide(makeCodexTransportLive(fixture.logger, {
        record(event) {
          fixture.recorder.diagnostics.push(event);
        },
      })),
      Effect.provide(fixture.layer),
    ),
  );
}

export function runTransport(
  fixture: TransportFixture,
  mode: "queue" | "steer" = "queue",
) {
  return Effect.runPromise(delivery(fixture, mode));
}

export function runTransportExit(
  fixture: TransportFixture,
  mode: "queue" | "steer" = "queue",
) {
  return Effect.runPromiseExit(delivery(fixture, mode));
}
