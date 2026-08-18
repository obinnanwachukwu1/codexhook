import assert from "node:assert/strict";
import test from "node:test";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import { localCodexService } from "../src/app-server/local-codex.js";
import { confirmLocalPlane } from "../src/app-server/service.js";
import type { LocalTaskRef } from "../src/contracts/local-codex.js";
import { DeliveryId, ThreadId } from "../src/types.js";
import {
  canonicalThread,
  canonicalTurn,
  fakeAppServerPeer,
} from "./support/app-server-fixture.js";

function localPlane(handler: Parameters<typeof fakeAppServerPeer>[0]) {
  const fixture = fakeAppServerPeer(handler);
  return {
    fixture,
    service: confirmLocalPlane(
      fixture.peer,
      "linux",
      "/home/user/.codex",
    ).pipe(Effect.map(localCodexService)),
  };
}

function historyResponse(
  method: string,
  params: unknown,
  turns: ReadonlyArray<ReturnType<typeof canonicalTurn>>,
) {
  if (method === "thread/list") {
    const archived = (params as { archived: boolean }).archived;
    return {
      data: archived ? [] : [canonicalThread("task-1", "cli", 9)],
      nextCursor: null,
    };
  }
  if (method === "thread/read") {
    return { thread: canonicalThread("task-1", "cli", 9) };
  }
  if (method === "thread/turns/list") {
    return { data: turns, nextCursor: null };
  }
  return {};
}

test("adapts canonical tasks and complete delivery-id history", async () => {
  const turn = canonicalTurn("turn-1", [
    { type: "userMessage", clientId: "delivery-1" },
    { type: "userMessage", clientId: "delivery-1" },
    { type: "agentMessage", clientId: "ignored" },
  ]);
  const plane = localPlane((method, params) =>
    historyResponse(method, params, [turn])
  );
  const result = await Effect.runPromise(Effect.gen(function* () {
    const service = yield* plane.service;
    const tasks = yield* service.listTasks;
    const resolved = yield* service.resolveTask(ThreadId("task-1"));
    const taskHistory = yield* service.readHistory(resolved);
    const availability = yield* service.availability;
    return { tasks, resolved, taskHistory, availability };
  }));

  assert.deepEqual(result.tasks, [{
    threadId: "task-1",
    origin: "cli",
    title: "preview task-1",
    updatedAt: 9,
  }]);
  assert.deepEqual(result.resolved, {
    threadId: "task-1",
    origin: "cli",
  });
  assert.deepEqual(result.taskHistory.turns, [{
    id: "turn-1",
    status: "completed",
    deliveryIds: ["delivery-1"],
  }]);
  assert.equal(result.availability.status, "available");
  if (result.availability.status === "available") {
    assert.equal(result.availability.compatibility.plane, "app-server");
    assert.equal(
      result.availability.compatibility.features.includes("delivery-id"),
      true,
    );
  }
});

test("subscribes before snapshot and emits only changed task turns", async () => {
  let turnReads = 0;
  let fixture: ReturnType<typeof fakeAppServerPeer>;
  const first = canonicalTurn("turn-1");
  const changed = { ...canonicalTurn("turn-1"), status: "inProgress" };
  const plane = localPlane((method, params) => {
    if (method === "thread/turns/list") {
      turnReads += 1;
      if (turnReads === 1) {
        fixture.emit({
          method: "turn/started",
          params: { threadId: "task-1", turn: { id: "turn-1" } },
        });
      }
      return {
        data: turnReads === 1 ? [first] : [changed],
        nextCursor: null,
      };
    }
    return historyResponse(method, params, [first]);
  });
  fixture = plane.fixture;
  const service = await Effect.runPromise(plane.service);
  const task = await Effect.runPromise(
    service.resolveTask(ThreadId("task-1")),
  );
  turnReads = 0;

  const collected = await Effect.runPromise(
    service.events(task).pipe(
      Stream.take(2),
      Stream.runCollect,
    ),
  );
  const events = Chunk.toReadonlyArray(collected);
  assert.equal(turnReads, 2);
  assert.equal(events[0]?.type, "snapshot");
  assert.deepEqual(events[1], {
    type: "turn-changed",
    task: { threadId: "task-1", origin: "cli" },
    turn: { id: "turn-1", status: "in-progress", deliveryIds: [] },
  });
});

test("maps queue and steer mutations to canonical submission truth", async () => {
  const active = { ...canonicalTurn("turn-active"), status: "inProgress" };
  const plane = localPlane((method, params) => {
    if (method === "turn/start") {
      return { turn: canonicalTurn("turn-started") };
    }
    if (method === "turn/steer") return { turnId: "turn-active" };
    return historyResponse(method, params, [active]);
  });
  const service = await Effect.runPromise(plane.service);
  const task = await Effect.runPromise(
    service.resolveTask(ThreadId("task-1")),
  );
  const started = await Effect.runPromise(service.submit({
    task,
    deliveryId: DeliveryId("delivery-start"),
    mode: "queue",
    message: "start",
    replyTimeout: Duration.seconds(5),
  }));
  const steered = await Effect.runPromise(service.submit({
    task,
    deliveryId: DeliveryId("delivery-steer"),
    mode: "steer",
    message: "steer",
    replyTimeout: Duration.seconds(5),
  }));

  assert.deepEqual(started, {
    _tag: "Confirmed",
    route: "app-server",
    deliveryId: "delivery-start",
    turnId: "turn-started",
    operation: "start",
  });
  assert.deepEqual(steered, {
    _tag: "Confirmed",
    route: "app-server",
    deliveryId: "delivery-steer",
    turnId: "turn-active",
    operation: "steer",
  });
  assert.deepEqual(plane.fixture.submissions, ["turn/start", "turn/steer"]);
});

test("does not submit a steer without exactly one active turn", async () => {
  for (const turns of [
    [canonicalTurn("turn-complete")],
    [
      { ...canonicalTurn("turn-1"), status: "inProgress" },
      { ...canonicalTurn("turn-2"), status: "inProgress" },
    ],
  ]) {
    const plane = localPlane((method, params) =>
      historyResponse(method, params, turns)
    );
    const service = await Effect.runPromise(plane.service);
    const task = await Effect.runPromise(
      service.resolveTask(ThreadId("task-1")),
    );
    const outcome = await Effect.runPromise(service.submit({
      task,
      deliveryId: DeliveryId("delivery-steer"),
      mode: "steer",
      message: "steer",
      replyTimeout: Duration.seconds(5),
    }));

    assert.equal(outcome._tag, "NotSubmitted");
    assert.deepEqual(plane.fixture.submissions, []);
  }
});

test("does not write through an unresolved runtime task reference", async () => {
  const plane = localPlane((method, params) =>
    historyResponse(method, params, [canonicalTurn("turn-1")])
  );
  const service = await Effect.runPromise(plane.service);
  const outcome = await Effect.runPromise(service.submit({
    task: {
      threadId: ThreadId("forged-task"),
      origin: "unknown",
    } as LocalTaskRef,
    deliveryId: DeliveryId("delivery-1"),
    mode: "queue",
    message: "do not write",
    replyTimeout: Duration.seconds(5),
  }));

  assert.equal(outcome._tag, "NotSubmitted");
  assert.deepEqual(plane.fixture.submissions, []);
});

test("maps post-submit interruption to one ambiguous public outcome", async () => {
  const fixture = fakeAppServerPeer((method, params) => {
    if (method === "turn/start") return { turn: canonicalTurn("turn-1") };
    return historyResponse(method, params, [canonicalTurn("turn-1")]);
  }, { replyFailure: "interrupted" });
  const canonical = await Effect.runPromise(
    confirmLocalPlane(fixture.peer, "linux", "/home/user/.codex"),
  );
  const service = localCodexService(canonical);
  const outcome = await Effect.runPromise(service.submit({
    task: {
      threadId: ThreadId("task-1"),
      origin: "cli",
    } as LocalTaskRef,
    deliveryId: DeliveryId("delivery-1"),
    mode: "queue",
    message: "write once",
    replyTimeout: Duration.seconds(5),
  }));

  assert.equal(outcome._tag, "Ambiguous");
  assert.deepEqual(fixture.submissions, ["turn/start"]);
});

test("blocks queries and writes for an unknown app-server binding", async () => {
  const fixture = fakeAppServerPeer(() => ({}), {
    serverInfo: {
      userAgent: "unknown-codex-build",
      codexHome: "/home/user/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
  });
  const canonical = await Effect.runPromise(
    confirmLocalPlane(fixture.peer, "linux", "/home/user/.codex"),
  );
  const service = localCodexService(canonical);
  const availability = await Effect.runPromise(service.availability);
  const listFailure = await Effect.runPromise(Effect.flip(service.listTasks));
  const outcome = await Effect.runPromise(service.submit({
    task: {
      threadId: ThreadId("task-1"),
      origin: "unknown",
    } as LocalTaskRef,
    deliveryId: DeliveryId("delivery-1"),
    mode: "queue",
    message: "do not write",
    replyTimeout: Duration.seconds(5),
  }));

  assert.equal(availability.status, "incompatible");
  assert.equal(listFailure.diagnostic.code, "app-server-incompatible");
  assert.equal(outcome._tag, "NotSubmitted");
  if (outcome._tag === "NotSubmitted") {
    assert.equal(outcome.reason, "incompatible");
  }
  assert.deepEqual(fixture.submissions, []);
});

test("projects canonical thread deletion after the initial snapshot", async () => {
  const plane = localPlane((method, params) =>
    historyResponse(method, params, [canonicalTurn("turn-1")])
  );
  const service = await Effect.runPromise(plane.service);
  const task = await Effect.runPromise(
    service.resolveTask(ThreadId("task-1")),
  );
  const fiber = Effect.runFork(service.events(task).pipe(
    Stream.take(2),
    Stream.runCollect,
  ));
  await tick();
  plane.fixture.emit({
    method: "thread/deleted",
    params: { threadId: "task-1" },
  });
  const events = Chunk.toReadonlyArray(
    await Effect.runPromise(Fiber.join(fiber)),
  );

  assert.equal(events[0]?.type, "snapshot");
  assert.deepEqual(events[1], { type: "task-removed", task });
});

test("stream closure is a sanitized local failure", async () => {
  const plane = localPlane((method, params) =>
    historyResponse(method, params, [canonicalTurn("turn-1")])
  );
  const service = await Effect.runPromise(plane.service);
  const task = await Effect.runPromise(
    service.resolveTask(ThreadId("task-1")),
  );
  const fiber = Effect.runFork(service.events(task).pipe(Stream.runDrain));
  await tick();
  plane.fixture.close();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure") {
    assert.equal(String(exit.cause).includes("disconnected"), true);
    assert.equal(String(exit.cause).includes("/home/user"), false);
  }
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
