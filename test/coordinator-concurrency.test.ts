import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Fiber } from "effect";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";
import type { DeliveryEvidence } from "../src/delivery/routing-contracts.js";
import { TurnId } from "../src/types.js";
import {
  coordinatorFixture,
  request,
} from "./support/coordinator-fixture.js";

const unresolved: DeliveryEvidence = {
  _tag: "Unresolved",
  diagnostic: { code: "timeout" },
};

function latch<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("reconciling does not block a later app-server command", async () => {
  const canonical = latch<DeliveryEvidence>();
  const entered = latch<void>();
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.succeed({
      _tag: "Uncertain",
      diagnostic: { code: "disconnected" },
    }),
    desktopEvidence: () => Effect.succeed(unresolved),
    canonicalEvidence: (delivery) =>
      delivery.deliveryId === "delivery-1"
        ? Effect.sync(() => entered.resolve()).pipe(
            Effect.zipRight(Effect.promise(() => canonical.promise)),
          )
        : Effect.succeed({ _tag: "Found", turnId: TurnId("turn-2") }),
    localReceipt: (input) => Effect.succeed({
      _tag: "Acknowledged",
      turnId: TurnId(input.deliveryId === "delivery-2" ? "turn-2" : "turn-1"),
    }),
  });
  try {
    const first = fixture.deliver(request("delivery-1", "thread-1", "30 seconds"));
    await entered.promise;
    assert.equal((await fixture.circuitState(request().threadId))._tag,
      "Reconciling");

    const secondResult = await fixture.deliver(request("delivery-2"));
    assert.equal(secondResult._tag, "ConfirmedAppServer");
    assert.deepEqual(fixture.recorder.desktopInjections, ["delivery-1"]);
    assert.deepEqual(fixture.recorder.localDeliveries, ["delivery-2"]);

    canonical.resolve(unresolved);
    assert.equal((await first)._tag, "Ambiguous");
    assert.equal((await fixture.circuitState(request().threadId))._tag, "Open");
  } finally {
    await fixture.runtime.dispose();
  }
});

test("reset cannot clear an in-flight reconciliation", async () => {
  const canonical = latch<DeliveryEvidence>();
  const entered = latch<void>();
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.succeed({
      _tag: "Uncertain",
      diagnostic: { code: "write-ambiguous" },
    }),
    canonicalEvidence: (delivery) =>
      delivery.deliveryId === "delivery-1"
        ? Effect.sync(() => entered.resolve()).pipe(
            Effect.zipRight(Effect.promise(() => canonical.promise)),
          )
        : Effect.succeed({ _tag: "Found", turnId: TurnId("turn-2") }),
  });
  try {
    const first = fixture.deliver(request("delivery-1", "thread-1", "30 seconds"));
    await entered.promise;
    await fixture.resetCircuit(request().threadId);
    assert.equal((await fixture.circuitState(request().threadId))._tag,
      "Reconciling");

    assert.equal(
      (await fixture.deliver(request("delivery-2")))._tag,
      "ConfirmedAppServer",
    );
    assert.deepEqual(fixture.recorder.desktopInjections, ["delivery-1"]);
    canonical.resolve(unresolved);
    await first;
  } finally {
    await fixture.runtime.dispose();
  }
});

test("an open circuit bypasses Desktop until verified reset", async () => {
  let canonicalCalls = 0;
  const fixture = coordinatorFixture({
    canonicalEvidence: () => Effect.succeed(
      ++canonicalCalls === 1
        ? unresolved
        : { _tag: "Found", turnId: TurnId("turn-3") },
    ),
    desktopEvidence: () => Effect.succeed(unresolved),
    desktopReceipt: () => Effect.succeed({
      _tag: "Uncertain",
      diagnostic: { code: "write-ambiguous" },
    }),
  });
  try {
    assert.equal((await fixture.deliver(request("delivery-1")))._tag,
      "Ambiguous");
    assert.equal((await fixture.deliver(request("delivery-2")))._tag,
      "ConfirmedAppServer");
    assert.deepEqual(fixture.recorder.routeStateQueries, ["thread-1"]);

    await fixture.resetCircuit(request().threadId);
    assert.equal((await fixture.deliver(request("delivery-3")))._tag,
      "ConfirmedDesktop");
    assert.deepEqual(fixture.recorder.routeStateQueries,
      ["thread-1", "thread-1"]);
  } finally {
    await fixture.runtime.dispose();
  }
});

test("simultaneous commands cannot both cross the desktop barrier", async () => {
  const canonical = latch<DeliveryEvidence>();
  const entered = latch<void>();
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.succeed({
      _tag: "Uncertain",
      diagnostic: { code: "write-ambiguous" },
    }),
    canonicalEvidence: () => Effect.sync(() => entered.resolve()).pipe(
      Effect.zipRight(Effect.promise(() => canonical.promise)),
    ),
  });
  try {
    const deliveries = [
      fixture.deliver(request("delivery-a", "thread-1", "30 seconds")),
      fixture.deliver(request("delivery-b", "thread-1", "30 seconds")),
    ] as const;
    await entered.promise;
    const appServerResult = await Promise.race(deliveries);
    assert.equal(appServerResult._tag, "ConfirmedAppServer");
    assert.equal(fixture.recorder.desktopInjections.length, 1);
    canonical.resolve(unresolved);
    const results = await Promise.all(deliveries);
    assert.deepEqual(
      results.map((result) => result._tag).sort(),
      ["Ambiguous", "ConfirmedAppServer"],
    );
  } finally {
    await fixture.runtime.dispose();
  }
});

test("per-task gates do not serialize independent tasks", async () => {
  const bothEntered = latch<void>();
  const release = latch<void>();
  const entered = new Set<string>();
  const fixture = coordinatorFixture({
    desktopReceipt: (input) => Effect.sync(() => {
      entered.add(input.threadId);
      if (entered.size === 2) bothEntered.resolve();
    }).pipe(
      Effect.zipRight(Effect.promise(() => release.promise)),
      Effect.as({
        _tag: "Acknowledged",
        turnId: TurnId(`turn-${input.threadId}`),
      }),
    ),
    desktopEvidence: (delivery) => Effect.succeed({
      _tag: "Found",
      turnId: TurnId(`turn-${delivery.threadId}`),
    }),
    canonicalEvidence: (delivery) => Effect.succeed({
      _tag: "Found",
      turnId: TurnId(`turn-${delivery.threadId}`),
    }),
  });
  try {
    const deliveries = [
      fixture.deliver(request("delivery-a", "thread-a", "30 seconds")),
      fixture.deliver(request("delivery-b", "thread-b", "30 seconds")),
    ] as const;
    await bothEntered.promise;
    release.resolve();
    const results = await Promise.all(deliveries);
    assert.equal(results.every((result) => result._tag === "ConfirmedDesktop"),
      true);
  } finally {
    await fixture.runtime.dispose();
  }
});

test("interruption converts Reconciling to an open circuit", async () => {
  const entered = latch<void>();
  const fixture = coordinatorFixture({
    canonicalEvidence: () => Effect.sync(() => entered.resolve()).pipe(
      Effect.zipRight(Effect.never),
    ),
  });
  try {
    const state = await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* DeliveryCoordinator;
        const fiber = yield* Effect.fork(
          coordinator.deliver(request(
            "delivery-interrupted",
            "thread-1",
            "30 seconds",
          )),
        );
        yield* Effect.promise(() => entered.promise);
        yield* Fiber.interrupt(fiber);
        return yield* coordinator.circuitState(request().threadId);
      }),
    );
    assert.equal(state._tag, "Open");
  } finally {
    await fixture.runtime.dispose();
  }
});

test("a stalled desktop injection times out and later commands remain usable", async () => {
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.never,
    desktopEvidence: () => Effect.succeed(unresolved),
    canonicalEvidence: () => Effect.succeed(unresolved),
  });
  try {
    const first = await fixture.deliver(request(
      "delivery-stalled",
      "thread-1",
      "10 millis",
    ));
    assert.equal(first._tag, "Ambiguous");
    assert.equal((await fixture.circuitState(request().threadId))._tag, "Open");

    const second = await fixture.deliver(request("delivery-later"));
    assert.equal(second._tag, "ConfirmedAppServer");
    assert.deepEqual(fixture.recorder.desktopInjections, ["delivery-stalled"]);
    assert.deepEqual(fixture.recorder.localDeliveries, ["delivery-later"]);
  } finally {
    await fixture.runtime.dispose();
  }
});

test("a timed-out native desktop write cannot fall back after absence", async () => {
  const completed = latch<void>();
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.promise(() => new Promise((resolve) => {
      setTimeout(() => {
        completed.resolve();
        resolve({
          _tag: "Acknowledged" as const,
          turnId: TurnId("turn-late"),
        });
      }, 30);
    })),
    desktopEvidence: () => Effect.succeed({ _tag: "Absent" }),
    canonicalEvidence: () => Effect.succeed({ _tag: "Absent" }),
  });
  try {
    const result = await fixture.deliver(request(
      "delivery-late",
      "thread-1",
      "10 millis",
    ));
    assert.equal(result._tag, "Ambiguous");
    assert.deepEqual(fixture.recorder.localDeliveries, []);
    assert.equal((await fixture.circuitState(request().threadId))._tag, "Open");

    await completed.promise;
    assert.deepEqual(fixture.recorder.localDeliveries, []);
  } finally {
    await fixture.runtime.dispose();
  }
});

test("a timed-out native app-server write remains ambiguous after absence", async () => {
  const completed = latch<void>();
  const fixture = coordinatorFixture({
    routeState: () => Effect.succeed({ _tag: "Unattached" }),
    localReceipt: () => Effect.promise(() => new Promise((resolve) => {
      setTimeout(() => {
        completed.resolve();
        resolve({
          _tag: "Acknowledged" as const,
          turnId: TurnId("turn-app-late"),
        });
      }, 30);
    })),
    canonicalEvidence: () => Effect.succeed({ _tag: "Absent" }),
  });
  try {
    const result = await fixture.deliver(request(
      "delivery-app-late",
      "thread-1",
      "10 millis",
    ));
    assert.equal(result._tag, "Ambiguous");
    assert.equal(result.proof.appServerReceipt?._tag, "Uncertain");
    assert.equal((await fixture.circuitState(request().threadId))._tag,
      "Closed");
    await completed.promise;
  } finally {
    await fixture.runtime.dispose();
  }
});

test("a hung desktop health probe cannot retain the task gate", async () => {
  const entered = latch<void>();
  let routeCalls = 0;
  const fixture = coordinatorFixture({
    routeState: () => {
      routeCalls += 1;
      entered.resolve();
      return Effect.never;
    },
  });
  try {
    const first = fixture.deliver(request(
      "delivery-health-timeout",
      "thread-1",
      "10 millis",
    ));
    await entered.promise;
    const second = fixture.deliver(request("delivery-after-health-timeout"));
    const results = await Promise.all([first, second]);
    assert.equal(results.every((result) =>
      result._tag === "ConfirmedAppServer"), true);
    assert.equal(routeCalls, 1);
    assert.equal((await fixture.circuitState(request().threadId))._tag, "Open");
    assert.deepEqual(fixture.recorder.localDeliveries,
      ["delivery-health-timeout", "delivery-after-health-timeout"]);
  } finally {
    await fixture.runtime.dispose();
  }
});

test("same-task app-server writes are serialized", async () => {
  const entered = latch<void>();
  const release = latch<void>();
  let calls = 0;
  const fixture = coordinatorFixture({
    routeState: () => Effect.succeed({ _tag: "Unattached" }),
    localReceipt: (input) => Effect.sync(() => {
      calls += 1;
      if (calls === 1) entered.resolve();
      return input;
    }).pipe(
      Effect.flatMap((current) => calls === 1
        ? Effect.promise(() => release.promise).pipe(Effect.as(current))
        : Effect.succeed(current)),
      Effect.map((current) => ({
        _tag: "Acknowledged" as const,
        turnId: TurnId(`turn-${current.deliveryId}`),
      })),
    ),
  });
  try {
    const deliveries = [
      fixture.deliver(request("delivery-a", "thread-1", "30 seconds")),
      fixture.deliver(request("delivery-b", "thread-1", "30 seconds")),
    ];
    await entered.promise;
    assert.equal(fixture.recorder.localDeliveries.length, 1);
    release.resolve();
    const results = await Promise.all(deliveries);
    assert.equal(results.every((result) =>
      result._tag === "ConfirmedAppServer"), true);
    assert.deepEqual(fixture.recorder.localDeliveries.sort(),
      ["delivery-a", "delivery-b"]);
  } finally {
    await fixture.runtime.dispose();
  }
});
