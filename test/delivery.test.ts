import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Stream,
} from "effect";
import {
  LocalDeliveryCoordinator,
  PHASE_ONE_DELIVERY_POLICY,
  type DeliveryCoordinator,
  type DeliveryOutcome,
} from "../src/contracts/delivery.js";
import {
  LocalCodex,
  type LocalCodexService,
  type LocalTaskRef,
} from "../src/contracts/local-codex.js";
import { sanitizeDiagnostic } from "../src/contracts/diagnostics.js";
import { Delivery, DeliveryLive } from "../src/delivery/delivery.js";
import { Logger } from "../src/logger.js";
import type { DiagnosticRecorder } from "../src/diagnostics/journal.js";
import {
  DeliveryId,
  ThreadId,
  TurnId,
  type WebhookRecord,
} from "../src/types.js";

function memoryLogger(): {
  readonly entries: Array<Record<string, unknown>>;
  readonly logger: Logger;
} {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    logger: new Logger(new Writable({
      write(chunk, _encoding, callback) {
        entries.push(JSON.parse(String(chunk)));
        callback();
      },
    })),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("log event timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function localTask(threadId: ThreadId): LocalTaskRef {
  return { threadId, origin: "cli" } as LocalTaskRef;
}

function runtime(
  coordinator: DeliveryCoordinator,
  logger = memoryLogger().logger,
  resolve: LocalCodexService["resolveTask"] = (threadId) =>
    Effect.succeed(localTask(threadId)),
  diagnostics?: DiagnosticRecorder,
) {
  const local = LocalCodex.of({
    availability: Effect.die("unused"),
    listTasks: Effect.die("unused"),
    readHistory: () => Effect.die("unused"),
    resolveTask: resolve,
    events: () => Stream.die("unused"),
    submit: () => Effect.die("unused"),
  } satisfies LocalCodexService);
  return ManagedRuntime.make(
    DeliveryLive(logger, diagnostics).pipe(Layer.provide(
      Layer.merge(
        Layer.succeed(LocalCodex, local),
        Layer.succeed(LocalDeliveryCoordinator, coordinator),
      ),
    )),
  );
}

function hook(mode: "queue" | "steer" = "queue"): WebhookRecord {
  return {
    id: "delivery-test",
    threadId: ThreadId("thread-1"),
    mode,
    prependBody: "",
    expiresAt: null,
    remainingDeliveries: null,
    createdAt: Date.now(),
  };
}

function confirmedOutcome(
  task: LocalTaskRef,
  deliveryId: DeliveryId,
): DeliveryOutcome {
  return {
    _tag: "ConfirmedDesktop",
    task,
    deliveryId,
    turnId: TurnId("turn-1"),
    operation: "start",
    attempts: [],
  };
}

test("resolves the accepted raw task before coordinating exactly once", async () => {
  const { entries, logger } = memoryLogger();
  let calls = 0;
  const coordinator = LocalDeliveryCoordinator.of({
    policy: PHASE_ONE_DELIVERY_POLICY,
    deliver: (request) => Effect.sync(() => {
      calls += 1;
      return {
        _tag: "Ambiguous" as const,
        task: request.task,
        deliveryId: request.deliveryId,
        route: "desktop" as const,
        attempts: [],
        diagnostic: sanitizeDiagnostic({
          code: "write-ambiguous",
          stage: "reconcile-app-server",
          route: "desktop",
          secret: "discarded",
        }),
      };
    }),
  });
  const service = runtime(coordinator, logger);
  try {
    const accepted = await service.runPromise(
      Effect.flatMap(Delivery, (delivery) =>
        delivery.submit(hook(), "review complete")
      ),
    );
    assert.equal(Option.isSome(accepted), true);
    await waitFor(() => entries.some((entry) =>
      entry.event === "delivery_finished"
    ));
    assert.equal(calls, 1);
    const finished = entries.find((entry) =>
      entry.event === "delivery_finished"
    );
    assert.equal(finished?.status, "Ambiguous");
    assert.equal(finished?.diagnosticCode, "write-ambiguous");
    assert.equal("secret" in (finished ?? {}), false);
  } finally {
    await service.dispose();
  }
});

test("resolution failure is logged without fabricating a local task", async () => {
  const { entries, logger } = memoryLogger();
  let coordinated = false;
  const coordinator = LocalDeliveryCoordinator.of({
    policy: PHASE_ONE_DELIVERY_POLICY,
    deliver: () => Effect.sync(() => {
      coordinated = true;
      throw new Error("must not coordinate");
    }),
  });
  const diagnostic = sanitizeDiagnostic({
    code: "task-not-found",
    stage: "resolve-task",
    route: "app-server",
  });
  const service = runtime(
    coordinator,
    logger,
    () => Effect.fail({ _tag: "LocalCodexFailure", diagnostic }),
  );
  try {
    const accepted = await service.runPromise(
      Effect.flatMap(Delivery, (delivery) =>
        delivery.submit(hook(), "missing task")
      ),
    );
    assert.equal(Option.isSome(accepted), true);
    await waitFor(() => entries.some((entry) =>
      entry.event === "delivery_failed"
    ));
    assert.equal(coordinated, false);
    const failed = entries.find((entry) => entry.event === "delivery_failed");
    assert.equal(failed?.stage, "resolve-task");
    assert.equal(failed?.diagnosticCode, "task-not-found");
  } finally {
    await service.dispose();
  }
});

test("records one terminal outcome and isolates recorder failure", async () => {
  const recorded: DeliveryOutcome[] = [];
  const recorder: DiagnosticRecorder = {
    recordOutcome(outcome) {
      recorded.push(outcome);
      throw new Error("best effort sink failed after recording");
    },
    recordDiagnostic() {},
  };
  const coordinator = LocalDeliveryCoordinator.of({
    policy: PHASE_ONE_DELIVERY_POLICY,
    deliver: (request) => Effect.succeed(
      confirmedOutcome(request.task, request.deliveryId),
    ),
  });
  const { entries, logger } = memoryLogger();
  const service = runtime(coordinator, logger, undefined, recorder);
  try {
    const accepted = await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.submit(hook(), "one")),
    );
    assert.equal(Option.isSome(accepted), true);
    await waitFor(() => entries.some((entry) =>
      entry.event === "delivery_finished"
    ));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?._tag, "ConfirmedDesktop");
  } finally {
    await service.dispose();
  }
});

test("records a sanitized resolution failure without a terminal outcome", async () => {
  const recorded = { outcomes: 0, diagnostics: [] as string[] };
  const recorder: DiagnosticRecorder = {
    recordOutcome() {
      recorded.outcomes += 1;
    },
    recordDiagnostic(value) {
      recorded.diagnostics.push(value.code);
    },
  };
  const failure = sanitizeDiagnostic({
    code: "task-not-found",
    stage: "resolve-task",
    body: "secret",
  });
  const coordinator = LocalDeliveryCoordinator.of({
    policy: PHASE_ONE_DELIVERY_POLICY,
    deliver: () => Effect.die("must not coordinate"),
  });
  const { entries, logger } = memoryLogger();
  const service = runtime(
    coordinator,
    logger,
    () => Effect.fail({ _tag: "LocalCodexFailure", diagnostic: failure }),
    recorder,
  );
  try {
    await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.submit(hook(), "one")),
    );
    await waitFor(() => entries.some((entry) =>
      entry.event === "delivery_failed"
    ));
    assert.deepEqual(recorded, {
      outcomes: 0,
      diagnostics: ["task-not-found"],
    });
  } finally {
    await service.dispose();
  }
});

test("drain stops admissions and waits for accepted work", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const coordinator = LocalDeliveryCoordinator.of({
    policy: PHASE_ONE_DELIVERY_POLICY,
    deliver: (request) => Deferred.await(gate).pipe(
      Effect.as(confirmedOutcome(request.task, request.deliveryId)),
    ),
  });
  const service = runtime(coordinator);
  try {
    const first = await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.submit(hook(), "one")),
    );
    assert.equal(Option.isSome(first), true);
    await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.stopAccepting),
    );
    const second = await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.submit(hook(), "two")),
    );
    assert.equal(Option.isNone(second), true);
    assert.equal(await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.drain("1 millis")),
    ), false);
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    assert.equal(await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.drain("1 second")),
    ), true);
  } finally {
    await service.dispose();
  }
});

test("steer dispatches immediately up to its in-flight bound", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const coordinator = LocalDeliveryCoordinator.of({
    policy: PHASE_ONE_DELIVERY_POLICY,
    deliver: (request) => Deferred.await(gate).pipe(
      Effect.as(confirmedOutcome(request.task, request.deliveryId)),
    ),
  });
  const service = runtime(coordinator);
  try {
    for (let index = 0; index < 100; index += 1) {
      const result = await service.runPromise(
        Effect.flatMap(Delivery, (delivery) =>
          delivery.submit(hook("steer"), "one")
        ),
      );
      assert.equal(Option.isSome(result), true);
    }
    const overflow = await service.runPromise(
      Effect.flatMap(Delivery, (delivery) =>
        delivery.submit(hook("steer"), "overflow")
      ),
    );
    assert.equal(Option.isNone(overflow), true);
    assert.equal((await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.snapshot),
    )).steerDepth, 100);
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    assert.equal(await service.runPromise(
      Effect.flatMap(Delivery, (delivery) => delivery.drain("1 second")),
    ), true);
  } finally {
    await service.dispose();
  }
});
