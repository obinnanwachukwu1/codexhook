import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Stream } from "effect";
import type { LocalTaskEvent } from "../src/contracts/local-codex.js";
import { DeliveryId, TurnId } from "../src/types.js";
import {
  coordinatorRuntime,
  deliver,
  diagnostic,
  request,
  snapshot,
  task,
} from "./support/coordinator-fixture.js";

test("Desktop confirmation closes its scoped session without app-server write", async () => {
  let localWrites = 0;
  let releases = 0;
  const service = coordinatorRuntime({
    localSubmit: () => Effect.sync(() => {
      localWrites += 1;
      throw new Error("must not write");
    }),
    onRelease: () => releases += 1,
  });
  try {
    const result = await deliver(service, request());
    assert.equal(result._tag, "ConfirmedDesktop");
    assert.equal(localWrites, 0);
    assert.equal(releases, 1);
  } finally {
    await service.dispose();
  }
});

test("only Desktop NotSubmitted falls back to one app-server write", async () => {
  let localWrites = 0;
  const input = request();
  const service = coordinatorRuntime({
    desktopSubmit: () => Effect.succeed({
      _tag: "NotSubmitted",
      route: "desktop",
      deliveryId: input.deliveryId,
      reason: "confirmed-not-submitted",
      diagnostic: diagnostic("desktop-unavailable", "desktop"),
    }),
    localSubmit: (submission) => Effect.sync(() => {
      localWrites += 1;
      return {
        _tag: "Confirmed" as const,
        route: "app-server" as const,
        deliveryId: submission.deliveryId,
        turnId: TurnId("fallback-turn"),
        operation: "steer" as const,
      };
    }),
  });
  try {
    const result = await deliver(service, input);
    assert.equal(result._tag, "ConfirmedAppServer");
    assert.equal(localWrites, 1);
    assert.deepEqual(result.attempts.map((item) => item.route), [
      "desktop",
      "app-server",
    ]);
  } finally {
    await service.dispose();
  }
});

test("Rejected and exhausted routes preserve truthful public outcomes", async () => {
  const input = request();
  const rejectedRuntime = coordinatorRuntime({
    desktopSubmit: () => Effect.succeed({
      _tag: "Rejected",
      route: "desktop",
      deliveryId: input.deliveryId,
      diagnostic: diagnostic("request-rejected", "desktop"),
    }),
  });
  const unavailableRuntime = coordinatorRuntime({
    desktopAvailability: Effect.succeed({
      status: "unavailable",
      diagnostic: diagnostic("desktop-unavailable", "desktop"),
    }),
    localSubmit: (submission) => Effect.succeed({
      _tag: "NotSubmitted",
      route: "app-server",
      deliveryId: submission.deliveryId,
      reason: "unavailable",
      diagnostic: diagnostic("app-server-unavailable", "app-server"),
    }),
  });
  try {
    assert.equal((await deliver(rejectedRuntime, input))._tag, "Rejected");
    assert.equal((await deliver(unavailableRuntime, input))._tag, "Unavailable");
  } finally {
    await rejectedRuntime.dispose();
    await unavailableRuntime.dispose();
  }
});

test("Desktop ambiguity reconciles from the initial canonical snapshot", async () => {
  const input = request();
  let localWrites = 0;
  const service = coordinatorRuntime({
    desktopSubmit: () => Effect.succeed({
      _tag: "Ambiguous",
      route: "desktop",
      deliveryId: input.deliveryId,
      diagnostic: diagnostic("write-ambiguous", "desktop"),
    }),
    events: () => Stream.succeed(snapshot(input, [input.deliveryId])),
    localSubmit: () => Effect.sync(() => {
      localWrites += 1;
      throw new Error("must not write");
    }),
  });
  try {
    const result = await deliver(service, input);
    assert.equal(result._tag, "ConfirmedDesktop");
    assert.equal(result.turnId, "observed-turn");
    assert.equal(localWrites, 0);
  } finally {
    await service.dispose();
  }
});

test("an unresolved ambiguous write never falls back", async () => {
  const input = request(task(), "ambiguous", "steer", "10 millis");
  let localWrites = 0;
  const service = coordinatorRuntime({
    desktopSubmit: () => Effect.succeed({
      _tag: "Ambiguous",
      route: "desktop",
      deliveryId: input.deliveryId,
      diagnostic: diagnostic("write-ambiguous", "desktop"),
    }),
    events: () => Stream.never,
    localSubmit: () => Effect.sync(() => {
      localWrites += 1;
      throw new Error("must not write");
    }),
  });
  try {
    assert.equal((await deliver(service, input))._tag, "Ambiguous");
    assert.equal(localWrites, 0);
  } finally {
    await service.dispose();
  }
});

test("app-server ambiguity can reconcile only by observation", async () => {
  const input = request();
  const service = coordinatorRuntime({
    desktopAvailability: Effect.succeed({
      status: "unavailable",
      diagnostic: diagnostic("desktop-unavailable", "desktop"),
    }),
    localSubmit: (submission) => Effect.succeed({
      _tag: "Ambiguous",
      route: "app-server",
      deliveryId: submission.deliveryId,
      diagnostic: diagnostic("write-ambiguous", "app-server"),
    }),
    events: () => Stream.succeed(snapshot(input, [input.deliveryId])),
  });
  try {
    assert.equal((await deliver(service, input))._tag, "ConfirmedAppServer");
  } finally {
    await service.dispose();
  }
});

test("reconciliation ignores a nonmatch and accepts a later matching event", async () => {
  const input = request();
  const changed: LocalTaskEvent = {
    type: "turn-changed",
    task: input.task,
    turn: {
      id: TurnId("later-turn"),
      status: "in-progress",
      deliveryIds: [input.deliveryId],
    },
  };
  const service = coordinatorRuntime({
    desktopSubmit: () => Effect.succeed({
      _tag: "Ambiguous",
      route: "desktop",
      deliveryId: input.deliveryId,
      diagnostic: diagnostic("write-ambiguous", "desktop"),
    }),
    events: () => Stream.fromIterable([
      snapshot(input, [DeliveryId("someone-else")]),
      changed,
    ]),
  });
  try {
    const result = await deliver(service, input);
    assert.equal(result._tag, "ConfirmedDesktop");
    assert.equal(result.turnId, "later-turn");
  } finally {
    await service.dispose();
  }
});

test("stream failure and task removal remain ambiguous without resubmission", async () => {
  let caseIndex = 0;
  for (const events of [
    Stream.fail({
      _tag: "LocalCodexFailure" as const,
      diagnostic: diagnostic("app-server-unavailable", "app-server"),
    }),
    Stream.succeed({
      type: "task-removed" as const,
      task: task(),
    }),
  ]) {
    caseIndex += 1;
    const input = request(task(), `case-${caseIndex}`, "steer", "10 millis");
    let localWrites = 0;
    const service = coordinatorRuntime({
      desktopSubmit: () => Effect.succeed({
        _tag: "Ambiguous",
        route: "desktop",
        deliveryId: input.deliveryId,
        diagnostic: diagnostic("write-ambiguous", "desktop"),
      }),
      events: () => events,
      localSubmit: () => Effect.sync(() => {
        localWrites += 1;
        throw new Error("must not write");
      }),
    });
    try {
      assert.equal((await deliver(service, input))._tag, "Ambiguous");
      assert.equal(localWrites, 0);
    } finally {
      await service.dispose();
    }
  }
});

test("an unexpected Desktop defect after submit is ambiguous and never falls back", async () => {
  const input = request();
  let localWrites = 0;
  const service = coordinatorRuntime({
    desktopSubmit: () => Effect.die("post-submit defect"),
    events: () => Stream.never,
    localSubmit: () => Effect.sync(() => {
      localWrites += 1;
      throw new Error("must not write");
    }),
  });
  try {
    assert.equal((await deliver(service, input))._tag, "Ambiguous");
    assert.equal(localWrites, 0);
  } finally {
    await service.dispose();
  }
});
