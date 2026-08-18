import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  appServerTaskStatus,
  AppServerTasks,
  AppServerTasksLive,
} from "../src/service/local-tasks.js";
import { ThreadId } from "../src/types.js";
import {
  RpcDisconnected,
  type AppServerPeer,
} from "../src/transport/rpc.js";
import { TransportUnavailable } from "../src/transport/errors.js";
import {
  TransportProvider,
  type TransportProviderService,
} from "../src/transport/provider.js";
import type { TransportSpec } from "../src/transport/spec.js";

const daemon: TransportSpec = {
  _tag: "UnixSocket",
  id: "daemon",
  socketPath: "/tmp/codex.sock",
  approvals: "decline",
};
const cli: TransportSpec = {
  _tag: "ChildProcess",
  id: "cli",
  executable: "codex",
  args: ["app-server"],
  approvals: "decline",
};

function task(id = "thread-1") {
  return {
    id,
    name: "Named task",
    preview: "First prompt",
    cwd: "/workspace",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [{ id: "turn-1" }],
  };
}

test("local task access reads canonical app-server list and history", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const connections: string[] = [];
  const peer = {
    request: (method: string, params: unknown) => {
      requests.push({ method, params });
      return Effect.succeed(
        method === "thread/list"
          ? { data: [task()], nextCursor: "next" }
          : { thread: task() },
      );
    },
    observe: () => Effect.never,
  } as unknown as AppServerPeer;
  const provider = TransportProvider.of({
    candidates: Effect.succeed([cli, daemon]),
    desktopCandidate: Effect.die("not used"),
    connect: (spec) =>
      Effect.sync(() => connections.push(spec.id)).pipe(
        Effect.flatMap(() =>
          spec.id === "daemon"
            ? Effect.fail(new TransportUnavailable({
                transport: "daemon",
                reason: "connect-failed",
                detail: "test",
              }))
            : Effect.succeed(peer),
        ),
      ),
  } satisfies TransportProviderService);
  const runtime = ManagedRuntime.make(
    AppServerTasksLive().pipe(
      Layer.provide(Layer.succeed(TransportProvider, provider)),
    ),
  );
  try {
    const page = await runtime.runPromise(
      Effect.flatMap(AppServerTasks, (access) => access.list({ limit: 5 })),
    );
    const history = await runtime.runPromise(
      Effect.flatMap(AppServerTasks, (access) =>
        access.history(ThreadId("thread-1")),
      ),
    );
    assert.equal(page.tasks[0]?.title, "Named task");
    assert.equal(page.nextCursor, "next");
    assert.deepEqual(history.turns, [{ id: "turn-1" }]);
    assert.deepEqual(requests.map(({ method }) => method), [
      "thread/list",
      "thread/read",
    ]);
    assert.deepEqual(connections, ["daemon", "cli", "daemon", "cli"]);
    assert.deepEqual(
      (requests[0]?.params as { sourceKinds?: unknown }).sourceKinds,
      [
        "cli",
        "vscode",
        "exec",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
        "unknown",
      ],
    );
  } finally {
    await runtime.dispose();
  }
});

test("task status derives from the transport health snapshot", () => {
  assert.deepEqual(
    appServerTaskStatus(["desktop", "daemon", "cli"]),
    {
      candidatesFound: true,
      candidates: ["daemon", "cli"],
      source: "app-server",
    },
  );
});

test("local task events expose app-server notifications safely", async () => {
  const events: Array<{ method: string; params: unknown }> = [];
  const peer = {
    observe: (listener: (event: { method: string; params: unknown }) => void) =>
      Effect.sync(() =>
        listener({ method: "thread/started", params: { thread: {} } }),
      ).pipe(
        Effect.zipRight(
          Effect.fail(new RpcDisconnected({ detail: "test complete" })),
        ),
      ),
  } as unknown as AppServerPeer;
  const provider = TransportProvider.of({
    candidates: Effect.succeed([daemon]),
    desktopCandidate: Effect.die("not used"),
    connect: () => Effect.succeed(peer),
  } satisfies TransportProviderService);
  const runtime = ManagedRuntime.make(
    AppServerTasksLive().pipe(
      Layer.provide(Layer.succeed(TransportProvider, provider)),
    ),
  );
  try {
    await assert.rejects(
      runtime.runPromise(
        Effect.scoped(
          Effect.flatMap(AppServerTasks, (access) =>
            access.events((event) => events.push(event)),
          ),
        ),
      ),
    );
    assert.deepEqual(events, [{
      method: "thread/started",
      params: { thread: {} },
    }]);
  } finally {
    await runtime.dispose();
  }
});

test("local task events report an unsupported peer distinctly", async () => {
  const provider = TransportProvider.of({
    candidates: Effect.succeed([daemon]),
    desktopCandidate: Effect.die("not used"),
    connect: () => Effect.succeed({} as AppServerPeer),
  } satisfies TransportProviderService);
  const runtime = ManagedRuntime.make(
    AppServerTasksLive().pipe(
      Layer.provide(Layer.succeed(TransportProvider, provider)),
    ),
  );
  try {
    const result = await runtime.runPromise(
      Effect.either(
        Effect.flatMap(AppServerTasks, (access) =>
          access.events(() => undefined),
        ),
      ),
    );
    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.equal(result.left.reason, "unsupported");
    }
  } finally {
    await runtime.dispose();
  }
});

test("task request failures do not fan out across app-server candidates", async () => {
  const connections: string[] = [];
  const peer = {
    request: () => Effect.fail(new Error("schema mismatch")),
  } as unknown as AppServerPeer;
  const provider = TransportProvider.of({
    candidates: Effect.succeed([daemon, cli]),
    desktopCandidate: Effect.die("not used"),
    connect: (spec) => Effect.sync(() => {
      connections.push(spec.id);
      return peer;
    }),
  } satisfies TransportProviderService);
  const runtime = ManagedRuntime.make(
    AppServerTasksLive().pipe(
      Layer.provide(Layer.succeed(TransportProvider, provider)),
    ),
  );
  try {
    await assert.rejects(
      runtime.runPromise(
        Effect.flatMap(AppServerTasks, (access) => access.list()),
      ),
    );
    assert.deepEqual(connections, ["daemon"]);
  } finally {
    await runtime.dispose();
  }
});
