import assert from "node:assert/strict";
import test from "node:test";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FiberId,
  Layer,
  Option,
  Schema,
} from "effect";
import {
  DeliveryId,
  ThreadId,
  type TurnRequest,
} from "../src/types.js";
import {
  DISPOSITIONS,
  SubmitAmbiguous,
  TransportUnavailable,
} from "../src/transport/errors.js";
import {
  type AppServerPeer,
  RpcNotWritten,
  RpcWriteAmbiguous,
} from "../src/transport/rpc.js";
import {
  TransportProvider,
  type TransportProviderService,
} from "../src/transport/provider.js";
import type { TransportSpec } from "../src/transport/spec.js";
import {
  CodexTransport,
  CodexTransportLive,
} from "../src/transport/transport.js";

type WriteBehavior =
  | "ok"
  | "active-ok"
  | "before-write"
  | "connect-fail"
  | "ambiguous";

interface Recorder {
  opens: string[];
  writes: Array<{ transport: string; method: string }>;
  live: number;
  maxLive: number;
}

const bundled: TransportSpec = {
  _tag: "ChildProcess",
  id: "app-bundled",
  executable: "/fake/bundled",
  args: [],
  coPresence: false,
  approvals: "decline",
};

const cli: TransportSpec = {
  _tag: "ChildProcess",
  id: "cli",
  executable: "/fake/cli",
  args: [],
  coPresence: false,
  approvals: "decline",
};

const desktop: TransportSpec = {
  _tag: "Desktop",
  id: "desktop",
  socketPath: "/fake/ipc.sock",
  coPresence: true,
  approvals: "decline",
};

const daemon: TransportSpec = {
  _tag: "UnixSocket",
  id: "daemon",
  socketPath: "/fake/app-server.sock",
  coPresence: false,
  approvals: "decline",
};

function fakePeer(
  spec: TransportSpec,
  behavior: WriteBehavior,
  recorder: Recorder,
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
    ): Effect.Effect<A, never> =>
      Effect.succeed(
        (method === "thread/resume"
          ? {
              thread: {
                id: "thread-1",
                turns:
                  behavior === "active-ok"
                    ? [{ id: "turn-active", status: "inProgress" }]
                    : [],
              },
            }
          : {}) as A,
      ),
    awaitTurn: (turnId) =>
      Effect.sync(() => {
        if (turnId === "turn-active") {
          recorder.writes.push({
            transport: spec.id,
            method: `await/${turnId}`,
          });
        }
        return { id: turnId, status: "completed" as const };
      }),
  };
}

function fakeProvider(
  scripts: Readonly<Record<string, WriteBehavior>>,
  candidates: ReadonlyArray<TransportSpec> = [bundled, cli],
): {
  layer: Layer.Layer<TransportProvider>;
  recorder: Recorder;
} {
  const recorder: Recorder = {
    opens: [],
    writes: [],
    live: 0,
    maxLive: 0,
  };
  const service: TransportProviderService = {
    candidates: Effect.succeed(candidates),
    connect: (spec) =>
      scripts[spec.id] === "connect-fail"
        ? Effect.fail(
            new TransportUnavailable({
              transport: spec.id,
              reason: "not-running",
              detail: "Desktop closed after discovery",
            }),
          )
        :
      Effect.acquireRelease(
        Effect.sync(() => {
          recorder.opens.push(spec.id);
          recorder.live += 1;
          recorder.maxLive = Math.max(recorder.maxLive, recorder.live);
          return fakePeer(spec, scripts[spec.id] ?? "ok", recorder);
        }),
        () =>
          Effect.sync(() => {
            recorder.live -= 1;
          }),
      ),
  };
  return {
    layer: Layer.succeed(TransportProvider, service),
    recorder,
  };
}

function request(mode: "queue" | "steer" = "queue"): TurnRequest {
  return {
    threadId: ThreadId("thread-1"),
    deliveryId: DeliveryId("delivery-1"),
    message: "hello",
    mode,
    idleTimeout: "1 second",
    turnTimeout: "1 second",
  };
}

function run(
  provider: Layer.Layer<TransportProvider>,
  mode: "queue" | "steer" = "queue",
): Promise<unknown> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(CodexTransport, (transport) =>
        transport.deliver(request(mode)),
      ).pipe(
        Effect.provide(CodexTransportLive),
        Effect.provide(provider),
      ),
    ),
  );
}

test("falls back only when turn bytes were provably not written", async () => {
  const { layer, recorder } = fakeProvider({
    "app-bundled": "before-write",
    cli: "ok",
  });
  const outcome = await run(layer);
  assert.deepEqual(recorder.opens, ["app-bundled", "cli"]);
  assert.deepEqual(recorder.writes, [
    { transport: "cli", method: "turn/start" },
  ]);
  assert.equal((outcome as { transport: string }).transport, "cli");
  assert.equal(recorder.maxLive, 1);
});

test("does not fall back after an ambiguous write", async () => {
  const { layer, recorder } = fakeProvider({
    "app-bundled": "ambiguous",
    cli: "ok",
  });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(CodexTransport, (transport) =>
        transport.deliver(request()),
      ).pipe(
        Effect.provide(CodexTransportLive),
        Effect.provide(layer),
      ),
    ),
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(Option.isSome(failure), true);
    if (Option.isSome(failure)) {
      assert.equal(failure.value instanceof SubmitAmbiguous, true);
    }
  }
  assert.deepEqual(recorder.opens, ["app-bundled"]);
  assert.deepEqual(recorder.writes, [
    { transport: "app-bundled", method: "turn/start" },
  ]);
  assert.equal(recorder.maxLive, 1);
});

test("prefers Desktop co-presence and safely falls back to the daemon", async () => {
  const { layer, recorder } = fakeProvider(
    {
      desktop: "before-write",
      daemon: "ok",
    },
    [desktop, daemon, bundled, cli],
  );
  const outcome = await run(layer);
  assert.deepEqual(recorder.opens, ["desktop", "daemon"]);
  assert.deepEqual(recorder.writes, [
    { transport: "daemon", method: "turn/start" },
  ]);
  assert.equal((outcome as { transport: string }).transport, "daemon");
  assert.equal(recorder.maxLive, 1);
});

test("a stale Desktop candidate falls back when the app closes", async () => {
  const { layer, recorder } = fakeProvider(
    { desktop: "connect-fail", daemon: "ok" },
    [desktop, daemon],
  );
  const outcome = await run(layer);
  assert.deepEqual(recorder.opens, ["daemon"]);
  assert.equal((outcome as { transport: string }).transport, "daemon");
});

test("never falls back when Desktop submission is ambiguous", async () => {
  const { layer, recorder } = fakeProvider(
    { desktop: "ambiguous", daemon: "ok" },
    [desktop, daemon],
  );
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(CodexTransport, (transport) =>
        transport.deliver(request()),
      ).pipe(
        Effect.provide(CodexTransportLive),
        Effect.provide(layer),
      ),
    ),
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(
      Option.isSome(failure) && failure.value instanceof SubmitAmbiguous,
      true,
    );
  }
  assert.deepEqual(recorder.opens, ["desktop"]);
  assert.deepEqual(recorder.writes, [
    { transport: "desktop", method: "turn/start" },
  ]);
});

test("queue waits for an active Desktop turn before starting", async () => {
  const { layer, recorder } = fakeProvider(
    { desktop: "active-ok" },
    [desktop, daemon],
  );
  const outcome = await run(layer, "queue");
  assert.deepEqual(recorder.writes, [
    { transport: "desktop", method: "await/turn-active" },
    { transport: "desktop", method: "turn/start" },
  ]);
  assert.equal((outcome as { transport: string }).transport, "desktop");
});

test("steer targets the active Desktop turn without waiting", async () => {
  const { layer, recorder } = fakeProvider(
    { desktop: "active-ok" },
    [desktop, daemon],
  );
  const outcome = await run(layer, "steer");
  assert.deepEqual(recorder.writes, [
    { transport: "desktop", method: "turn/steer" },
  ]);
  assert.equal((outcome as { _tag: string })._tag, "Steered");
});

test("classifies every transport error and forbids ambiguous retry", () => {
  assert.equal(DISPOSITIONS.TransportUnavailable.recovery, "try-next");
  assert.equal(DISPOSITIONS.TransportIncompatible.recovery, "try-next");
  assert.deepEqual(DISPOSITIONS.SubmitAmbiguous, {
    recovery: "stop",
    submission: "unknown",
  });
  assert.deepEqual(DISPOSITIONS.TurnAbandoned, {
    recovery: "stop",
    submission: "unknown",
  });
});
