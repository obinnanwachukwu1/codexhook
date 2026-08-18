import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Option,
} from "effect";
import {
  Delivery,
  DeliveryLive,
} from "../src/delivery/delivery.js";
import { Logger } from "../src/logger.js";
import type { DiagnosticEvent } from "../src/diagnostics/contracts.js";
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
  const diagnostics: DiagnosticEvent[] = [];
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
    DeliveryLive(logger, {
      record(event) {
        diagnostics.push(event);
      },
    }).pipe(
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
    assert.equal(
      diagnostics.some((event) =>
        event.code === "canonical.unknown" &&
        event.deliveryTruth === "confirmed_app_server"
      ),
      true,
    );
  } finally {
    await runtime.dispose();
  }
});

test("serializes each task while allowing different tasks to run concurrently", async () => {
  const { entries, logger } = memoryLogger();
  const liveByThread = new Map<string, number>();
  const maxByThread = new Map<string, number>();
  let live = 0;
  let maxLive = 0;
  const transport = CodexTransport.of({
    deliver: (request) => Effect.acquireUseRelease(
      Effect.sync(() => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        const threadLive = (liveByThread.get(request.threadId) ?? 0) + 1;
        liveByThread.set(request.threadId, threadLive);
        maxByThread.set(
          request.threadId,
          Math.max(maxByThread.get(request.threadId) ?? 0, threadLive),
        );
      }),
      () => Effect.sleep("30 millis"),
      () => Effect.sync(() => {
        live -= 1;
        liveByThread.set(
          request.threadId,
          (liveByThread.get(request.threadId) ?? 1) - 1,
        );
      }),
    ).pipe(Effect.as({
      _tag: "Completed" as const,
      threadId: request.threadId,
      turnId: TurnId(`turn-${request.deliveryId}`),
      transport: "cli" as const,
    })),
    status: Effect.succeed({
      candidates: ["cli"],
      desktopIpcAvailable: false,
    }),
  } satisfies CodexTransportService);
  const runtime = ManagedRuntime.make(
    DeliveryLive(logger).pipe(
      Layer.provide(Layer.succeed(CodexTransport, transport)),
    ),
  );
  const hook = (id: string, thread: string): WebhookRecord => ({
    id,
    threadId: ThreadId(thread),
    mode: "queue",
    prependBody: "",
    expiresAt: null,
    remainingDeliveries: null,
    createdAt: Date.now(),
  });

  try {
    await Promise.all([
      runtime.runPromise(Effect.flatMap(Delivery, (delivery) =>
        delivery.submit(hook("one-a", "thread-1"), "a"))),
      runtime.runPromise(Effect.flatMap(Delivery, (delivery) =>
        delivery.submit(hook("one-b", "thread-1"), "b"))),
      runtime.runPromise(Effect.flatMap(Delivery, (delivery) =>
        delivery.submit(hook("two", "thread-2"), "c"))),
    ]);
    await waitFor(() =>
      entries.filter((entry) => entry.event === "delivery_finished").length === 3,
    );
    assert.equal(maxLive, 2);
    assert.equal(maxByThread.get("thread-1"), 1);
    assert.equal(maxByThread.get("thread-2"), 1);
  } finally {
    await runtime.dispose();
  }
});
