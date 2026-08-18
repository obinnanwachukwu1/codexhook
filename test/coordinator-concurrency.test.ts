import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import type { DeliveryEvidence } from "../src/delivery/routing-contracts.js";
import { TurnId } from "../src/types.js";
import {
  coordinatorFixture,
  request,
} from "./support/coordinator-fixture.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("a reconciling desktop write does not block a later app-server command", async () => {
  let resolveCanonical!: (value: DeliveryEvidence) => void;
  const canonical = new Promise<DeliveryEvidence>((resolve) => {
    resolveCanonical = resolve;
  });
  const fixture = coordinatorFixture({
    desktopReceipt: {
      _tag: "Uncertain",
      detail: "desktop disconnected after sending",
    },
    desktopEvidence: {
      _tag: "Unresolved",
      detail: "desktop state unavailable",
    },
    canonicalEvidence: (input, source) =>
      source === "desktop" && input.deliveryId === "delivery-1"
        ? Effect.promise(() => canonical)
        : Effect.succeed({ _tag: "Found", turnId: TurnId("turn-2") }),
    localReceipt: (input) => Effect.succeed({
      _tag: "Acknowledged",
      turnId: TurnId(input.deliveryId === "delivery-2" ? "turn-2" : "turn-1"),
    }),
  });
  try {
    const first = fixture.deliver(request("delivery-1"));
    await waitFor(() => fixture.recorder.reconciliations.length === 1);
    assert.equal((await fixture.circuitState(request().threadId))._tag, "Reconciling");

    const second = fixture.deliver(request("delivery-2"));
    const secondResult = await Promise.race([
      second,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("later command was blocked")), 100)),
    ]);
    assert.equal(secondResult._tag, "ConfirmedAppServer");
    assert.deepEqual(fixture.recorder.desktopInjections, ["delivery-1"]);
    assert.deepEqual(fixture.recorder.localDeliveries, ["delivery-2"]);

    resolveCanonical({ _tag: "Unresolved", detail: "event barrier timed out" });
    const firstResult = await first;
    assert.equal(firstResult._tag, "Ambiguous");
    assert.equal((await fixture.circuitState(request().threadId))._tag, "Open");
  } finally {
    await fixture.runtime.dispose();
  }
});

test("simultaneous commands cannot both cross the desktop injection barrier", async () => {
  let resolveCanonical!: (value: DeliveryEvidence) => void;
  const canonical = new Promise<DeliveryEvidence>((resolve) => {
    resolveCanonical = resolve;
  });
  const fixture = coordinatorFixture({
    desktopReceipt: {
      _tag: "Uncertain",
      detail: "write outcome unknown",
    },
    canonicalEvidence: (_input, source) => source === "desktop"
      ? Effect.promise(() => canonical)
      : Effect.succeed({ _tag: "Found", turnId: TurnId("turn-app") }),
    localReceipt: {
      _tag: "Acknowledged",
      turnId: TurnId("turn-app"),
    },
  });
  try {
    const first = fixture.deliver(request("delivery-a"));
    const second = fixture.deliver(request("delivery-b"));
    await waitFor(() => fixture.recorder.localDeliveries.length === 1);
    assert.equal(fixture.recorder.desktopInjections.length, 1);
    assert.equal(fixture.recorder.localDeliveries.length, 1);
    resolveCanonical({ _tag: "Unresolved", detail: "not proven" });
    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map((result) => result._tag).sort(),
      ["Ambiguous", "ConfirmedAppServer"],
    );
  } finally {
    await fixture.runtime.dispose();
  }
});

test("per-task gates do not serialize independent tasks", async () => {
  const entered = new Set<string>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = coordinatorFixture({
    desktopReceipt: (input) => Effect.sync(() => {
      entered.add(input.threadId);
    }).pipe(
      Effect.zipRight(Effect.promise(() => blocked)),
      Effect.as({ _tag: "Acknowledged", turnId: TurnId(`turn-${input.threadId}`) }),
    ),
    desktopEvidence: (input) => Effect.succeed({
      _tag: "Found",
      turnId: TurnId(`turn-${input.threadId}`),
    }),
    canonicalEvidence: (input) => Effect.succeed({
      _tag: "Found",
      turnId: TurnId(`turn-${input.threadId}`),
    }),
  });
  try {
    const first = fixture.deliver(request("delivery-a", "thread-a"));
    const second = fixture.deliver(request("delivery-b", "thread-b"));
    await waitFor(() => entered.size === 2);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results.every((result) => result._tag === "ConfirmedDesktop"), true);
  } finally {
    await fixture.runtime.dispose();
  }
});
