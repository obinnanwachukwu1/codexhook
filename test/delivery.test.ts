import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  Effect,
  Deferred,
  Layer,
  ManagedRuntime,
  Option,
} from "effect";
import {
  Delivery,
  DeliveryLive,
} from "../src/delivery/delivery.js";
import { Logger } from "../src/logger.js";
import {
  ThreadId,
  TurnId,
  type WebhookRecord,
} from "../src/types.js";
import { DesktopVisibilityUnconfirmed } from "../src/transport/errors.js";
import {
  CodexTransport,
  type CodexTransportService,
} from "../src/transport/transport.js";

function memoryLogger(): {
  readonly entries: Array<Record<string, unknown>>;
  readonly logger: Logger;
} {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    logger: new Logger(
      new Writable({
        write(chunk, _encoding, callback) {
          entries.push(JSON.parse(String(chunk)));
          callback();
        },
      }),
    ),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("log event timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("does not log delivery_finished when Desktop visibility is unconfirmed", async () => {
  const { entries, logger } = memoryLogger();
  const threadId = ThreadId("thread-1");
  const turnId = TurnId("turn-1");
  const transport = CodexTransport.of({
    deliver: () =>
      Effect.fail(
        new DesktopVisibilityUnconfirmed({
          threadId,
          turnId,
          submittedTransport: "daemon",
          detail: "Desktop thread state timed out",
        }),
      ),
    status: Effect.succeed({
      candidates: ["desktop", "daemon"],
      desktopIpcAvailable: true,
    }),
  } satisfies CodexTransportService);
  const runtime = ManagedRuntime.make(
    DeliveryLive(logger).pipe(
      Layer.provide(Layer.succeed(CodexTransport, transport)),
    ),
  );
  const hook: WebhookRecord = {
    id: "review",
    threadId,
    mode: "queue",
    prependBody: "",
    expiresAt: null,
    remainingDeliveries: null,
    createdAt: Date.now(),
  };

  try {
    const accepted = await runtime.runPromise(
      Effect.flatMap(Delivery, (delivery) =>
        delivery.submit(hook, "review complete"),
      ),
    );
    assert.equal(Option.isSome(accepted), true);
    await waitFor(() =>
      entries.some((entry) => entry.event === "delivery_failed"),
    );

    const failed = entries.find(
      (entry) => entry.event === "delivery_failed",
    );
    assert.equal(failed?.errorTag, "DesktopVisibilityUnconfirmed");
    assert.equal(failed?.submission, "submitted");
    assert.equal(
      entries.some((entry) => entry.event === "delivery_finished"),
      false,
    );
  } finally {
    await runtime.dispose();
  }
});

test("drain stops admissions and waits for accepted work", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const threadId = ThreadId("thread-1");
  const turnId = TurnId("turn-1");
  const transport = CodexTransport.of({
    deliver: (request) =>
      Deferred.await(gate).pipe(
        Effect.as({
          _tag: "Completed" as const,
          threadId: request.threadId,
          turnId,
          transport: "desktop" as const,
        }),
      ),
    status: Effect.succeed({
      candidates: ["desktop"],
      desktopIpcAvailable: true,
    }),
  } satisfies CodexTransportService);
  const runtime = ManagedRuntime.make(
    DeliveryLive().pipe(
      Layer.provide(Layer.succeed(CodexTransport, transport)),
    ),
  );
  const hook: WebhookRecord = {
    id: "drain",
    threadId,
    mode: "queue",
    prependBody: "",
    expiresAt: null,
    remainingDeliveries: null,
    createdAt: Date.now(),
  };

  try {
    const first = await runtime.runPromise(
      Effect.flatMap(Delivery, (service) => service.submit(hook, "one")),
    );
    assert.equal(Option.isSome(first), true);
    await runtime.runPromise(
      Effect.flatMap(Delivery, (service) => service.stopAccepting),
    );
    const second = await runtime.runPromise(
      Effect.flatMap(Delivery, (service) => service.submit(hook, "two")),
    );
    assert.equal(Option.isNone(second), true);
    assert.equal(
      await runtime.runPromise(
        Effect.flatMap(Delivery, (service) => service.drain("1 millis")),
      ),
      false,
    );
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    assert.equal(
      await runtime.runPromise(
        Effect.flatMap(Delivery, (service) => service.drain("1 second")),
      ),
      true,
    );
  } finally {
    await runtime.dispose();
  }
});
