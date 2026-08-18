import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Stream } from "effect";
import type { LocalTaskEvent } from "../src/contracts/local-codex.js";
import { LocalDeliveryCoordinator } from "../src/contracts/delivery.js";
import { TurnId } from "../src/types.js";
import {
  coordinatorRuntime,
  deliver,
  diagnostic,
  request,
  snapshot,
  task,
} from "./support/coordinator-fixture.js";

test("same-task mutation sections serialize while different tasks proceed", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  let entered = 0;
  const service = coordinatorRuntime({
    desktopSubmit: (submission) => Effect.gen(function* () {
      entered += 1;
      yield* Deferred.await(gate);
      return {
        _tag: "Confirmed" as const,
        route: "desktop" as const,
        deliveryId: submission.deliveryId,
        turnId: TurnId("serialized-turn"),
        operation: "steer" as const,
      };
    }),
  });
  try {
    const coordinator = await service.runPromise(LocalDeliveryCoordinator);
    const first = Effect.runFork(coordinator.deliver(request(task(), "first")));
    const secondPromise = deliver(service, request(task(), "second"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(entered, 1);
    const otherPromise = deliver(
      service,
      request(task("thread-2"), "third"),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(entered, 2);
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await Promise.all([
      Effect.runPromise(first.await),
      secondPromise,
      otherPromise,
    ]);
  } finally {
    await service.dispose();
  }
});

test("an ambiguous Desktop breaker releases the gate for canonical writes", async () => {
  const input = request(task(), "first", "steer", "100 millis");
  let desktopWrites = 0;
  let localWrites = 0;
  const service = coordinatorRuntime({
    desktopSubmit: (submission) => Effect.sync(() => {
      desktopWrites += 1;
      return {
        _tag: "Ambiguous" as const,
        route: "desktop" as const,
        deliveryId: submission.deliveryId,
        diagnostic: diagnostic("write-ambiguous", "desktop"),
      };
    }),
    events: () => Stream.never,
    localSubmit: (submission) => Effect.sync(() => {
      localWrites += 1;
      return {
        _tag: "Confirmed" as const,
        route: "app-server" as const,
        deliveryId: submission.deliveryId,
        turnId: TurnId("later-turn"),
        operation: "steer" as const,
      };
    }),
  });
  try {
    const first = deliver(service, input);
    while (desktopWrites === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = await deliver(service, request(task(), "second"));
    assert.equal(second._tag, "ConfirmedAppServer");
    assert.equal(desktopWrites, 1);
    assert.equal(localWrites, 1);
    assert.equal((await first)._tag, "Ambiguous");
  } finally {
    await service.dispose();
  }
});

test("queue mode waits for canonical idle evidence before mutation", async () => {
  const input = request(task(), "queue", "queue");
  const active: LocalTaskEvent = {
    type: "snapshot",
    history: {
      task: input.task,
      turns: [{
        id: TurnId("active"),
        status: "in-progress",
        deliveryIds: [],
      }],
    },
  };
  const completed: LocalTaskEvent = {
    type: "turn-changed",
    task: input.task,
    turn: {
      id: TurnId("active"),
      status: "completed",
      deliveryIds: [],
    },
  };
  let subscriptions = 0;
  const service = coordinatorRuntime({
    activeTurnId: null,
    events: () => {
      subscriptions += 1;
      return subscriptions === 1
        ? Stream.fromIterable([active, completed])
        : Stream.succeed(snapshot(input));
    },
  });
  try {
    assert.equal((await deliver(service, input))._tag, "ConfirmedDesktop");
  } finally {
    await service.dispose();
  }
});
