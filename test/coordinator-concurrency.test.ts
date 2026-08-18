import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
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

test("Desktop busy waits for a canonical activity cycle without fallback or polling", async () => {
  const input = request(task(), "queue-race", "queue", "200 millis");
  const releaseActivity = await Effect.runPromise(Deferred.make<void>());
  const active: LocalTaskEvent = {
    type: "snapshot",
    history: {
      task: input.task,
      turns: [{
        id: TurnId("racing-turn"),
        status: "in-progress",
        deliveryIds: [],
      }],
    },
  };
  const completed: LocalTaskEvent = {
    type: "turn-changed",
    task: input.task,
    turn: {
      id: TurnId("racing-turn"),
      status: "completed",
      deliveryIds: [],
    },
  };
  let subscriptions = 0;
  let desktopSubmits = 0;
  let localWrites = 0;
  const service = coordinatorRuntime({
    activeTurnId: null,
    events: () => {
      subscriptions += 1;
      if (subscriptions !== 3) return Stream.succeed(snapshot(input));
      return Stream.concat(
        Stream.succeed(snapshot(input)),
        Stream.concat(
          Stream.fromEffect(Deferred.await(releaseActivity).pipe(
            Effect.as(active),
          )),
          Stream.succeed(completed),
        ),
      );
    },
    desktopSubmit: (submission) => Effect.sync(() => {
      desktopSubmits += 1;
      if (desktopSubmits === 1) {
        return {
          _tag: "NotSubmitted" as const,
          route: "desktop" as const,
          deliveryId: submission.deliveryId,
          reason: "task-busy" as const,
          diagnostic: diagnostic("desktop-unavailable", "desktop"),
        };
      }
      return {
        _tag: "Confirmed" as const,
        route: "desktop" as const,
        deliveryId: submission.deliveryId,
        turnId: TurnId("queued-turn"),
        operation: "start" as const,
      };
    }),
    localSubmit: () => Effect.sync(() => {
      localWrites += 1;
      throw new Error("must not fall back while the task is busy");
    }),
  });
  try {
    const pending = deliver(service, input);
    while (desktopSubmits === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(desktopSubmits, 1);
    assert.equal(localWrites, 0);
    await Effect.runPromise(Deferred.succeed(releaseActivity, undefined));
    assert.equal((await pending)._tag, "ConfirmedDesktop");
    assert.equal(desktopSubmits, 2);
    assert.equal(localWrites, 0);
  } finally {
    await service.dispose();
  }
});

test("multiple Desktop-active turns wait and never fall back", async () => {
  const input = request(task(), "multiple-active", "queue", "10 millis");
  let localWrites = 0;
  const service = coordinatorRuntime({
    desktopFollow: (localTask) => Effect.succeed({
      task: localTask,
      activity: "multiple-active",
      activeTurnId: null,
    }),
    localSubmit: () => Effect.sync(() => {
      localWrites += 1;
      throw new Error("multiple Desktop turns cannot authorize fallback");
    }),
  });
  try {
    assert.equal((await deliver(service, input))._tag, "Unavailable");
    assert.equal(localWrites, 0);
  } finally {
    await service.dispose();
  }
});

test("interrupting Desktop preparation cannot start an app-server fallback", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  let localWrites = 0;
  const service = coordinatorRuntime({
    desktopFollow: () => Deferred.succeed(entered, undefined).pipe(
      Effect.zipRight(Effect.never),
    ),
    localSubmit: () => Effect.sync(() => {
      localWrites += 1;
      throw new Error("shutdown must not start another write");
    }),
  });
  try {
    const coordinator = await service.runPromise(LocalDeliveryCoordinator);
    const fiber = Effect.runFork(coordinator.deliver(request()));
    await Effect.runPromise(Deferred.await(entered));
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(Cause.isInterruptedOnly(exit.cause), true);
    }
    assert.equal(localWrites, 0);
  } finally {
    await service.dispose();
  }
});

test("interrupting an app-server submission remains an interruption", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  let submissions = 0;
  const service = coordinatorRuntime({
    desktopAvailability: Effect.succeed({
      status: "unavailable",
      diagnostic: diagnostic("desktop-unavailable", "desktop"),
    }),
    localSubmit: () => Effect.sync(() => {
      submissions += 1;
    }).pipe(
      Effect.zipRight(Deferred.succeed(entered, undefined)),
      Effect.zipRight(Effect.never),
    ),
  });
  try {
    const coordinator = await service.runPromise(LocalDeliveryCoordinator);
    const fiber = Effect.runFork(coordinator.deliver(request()));
    await Effect.runPromise(Deferred.await(entered));
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(Cause.isInterruptedOnly(exit.cause), true);
    }
    assert.equal(submissions, 1);
  } finally {
    await service.dispose();
  }
});
