import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  LocalTaskAccess,
  LocalTaskAccessLive,
} from "../src/service/local-tasks.js";
import { ThreadId } from "../src/types.js";
import type { AppServerPeer } from "../src/transport/rpc.js";
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
    connect: (spec) => Effect.sync(() => {
      connections.push(spec.id);
      return peer;
    }),
  } satisfies TransportProviderService);
  const runtime = ManagedRuntime.make(
    LocalTaskAccessLive().pipe(
      Layer.provide(Layer.succeed(TransportProvider, provider)),
    ),
  );
  try {
    const page = await runtime.runPromise(
      Effect.flatMap(LocalTaskAccess, (access) => access.list({ limit: 5 })),
    );
    const history = await runtime.runPromise(
      Effect.flatMap(LocalTaskAccess, (access) =>
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
    assert.deepEqual(connections, ["daemon", "daemon"]);
    assert.deepEqual(
      (requests[0]?.params as { sourceKinds?: unknown }).sourceKinds,
      [],
    );
  } finally {
    await runtime.dispose();
  }
});
