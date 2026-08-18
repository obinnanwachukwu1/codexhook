import { Writable } from "node:stream";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  DeliveryCoordinator,
  DeliveryCoordinatorLive,
} from "../../src/delivery/coordinator.js";
import {
  CanonicalDeliveryPort,
  type CanonicalDeliveryPortService,
  type DeliveryEvidence,
  type DeliveryReceipt,
  type DeliveryRef,
  type DesktopRouteState,
  DesktopDeliveryPort,
  type DesktopDeliveryPortService,
} from "../../src/delivery/routing-contracts.js";
import { Logger } from "../../src/logger.js";
import {
  DeliveryId,
  ThreadId,
  TurnId,
  type TurnRequest,
} from "../../src/types.js";

export interface CoordinatorRecorder {
  readonly desktopEvidence: string[];
  readonly desktopInjections: string[];
  readonly localDeliveries: string[];
  readonly logs: Array<Record<string, unknown>>;
  readonly reconciliations: string[];
  readonly routeStateQueries: string[];
}

export interface CoordinatorFixtureOptions {
  readonly routeState?: (
    threadId: ThreadId,
  ) => Effect.Effect<DesktopRouteState>;
  readonly desktopReceipt?: (
    request: TurnRequest,
  ) => Effect.Effect<DeliveryReceipt>;
  readonly desktopEvidence?: (
    delivery: DeliveryRef,
  ) => Effect.Effect<DeliveryEvidence>;
  readonly localReceipt?: (
    request: TurnRequest,
  ) => Effect.Effect<DeliveryReceipt>;
  readonly canonicalEvidence?: (
    delivery: DeliveryRef,
  ) => Effect.Effect<DeliveryEvidence>;
}

export function request(
  deliveryId = "delivery-1",
  threadId = "thread-1",
  turnTimeout: TurnRequest["turnTimeout"] = "1 second",
): TurnRequest {
  return {
    threadId: ThreadId(threadId),
    deliveryId: DeliveryId(deliveryId),
    message: "private webhook body",
    mode: "queue",
    idleTimeout: "1 second",
    turnTimeout,
  };
}

export function coordinatorFixture(options: CoordinatorFixtureOptions = {}) {
  const recorder: CoordinatorRecorder = {
    desktopEvidence: [],
    desktopInjections: [],
    localDeliveries: [],
    logs: [],
    reconciliations: [],
    routeStateQueries: [],
  };
  const desktop: DesktopDeliveryPortService = {
    routeState: (threadId) => Effect.sync(() => {
      recorder.routeStateQueries.push(threadId);
    }).pipe(
      Effect.zipRight(
        options.routeState?.(threadId) ??
          Effect.succeed({ _tag: "HealthyAttached" }),
      ),
    ),
    inject: (input) => Effect.sync(() => {
      recorder.desktopInjections.push(input.deliveryId);
    }).pipe(
      Effect.zipRight(
        options.desktopReceipt?.(input) ?? Effect.succeed({
          _tag: "Acknowledged",
          turnId: TurnId("turn-1"),
        }),
      ),
    ),
    evidence: (delivery) => Effect.sync(() => {
      recorder.desktopEvidence.push(delivery.deliveryId);
    }).pipe(
      Effect.zipRight(
        options.desktopEvidence?.(delivery) ?? Effect.succeed({
          _tag: "Found",
          turnId: TurnId("turn-1"),
        }),
      ),
    ),
  };
  const local: CanonicalDeliveryPortService = {
    deliver: (input) => Effect.sync(() => {
      recorder.localDeliveries.push(input.deliveryId);
    }).pipe(
      Effect.zipRight(
        options.localReceipt?.(input) ?? Effect.succeed({
          _tag: "Acknowledged",
          turnId: TurnId("turn-app"),
        }),
      ),
    ),
    reconcile: (delivery) => Effect.sync(() => {
      recorder.reconciliations.push(delivery.deliveryId);
    }).pipe(
      Effect.zipRight(
        options.canonicalEvidence?.(delivery) ?? Effect.succeed({
          _tag: "Found",
          turnId: TurnId("turn-1"),
        }),
      ),
    ),
  };
  const logger = new Logger(new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.length === 0) continue;
        try {
          recorder.logs.push(JSON.parse(line));
        } catch {
          recorder.logs.push({ raw: line });
        }
      }
      callback();
    },
  }));
  const dependencies = Layer.merge(
    Layer.succeed(DesktopDeliveryPort, DesktopDeliveryPort.of(desktop)),
    Layer.succeed(CanonicalDeliveryPort, CanonicalDeliveryPort.of(local)),
  );
  const runtime = ManagedRuntime.make(
    DeliveryCoordinatorLive(logger).pipe(Layer.provide(dependencies)),
  );
  return {
    recorder,
    runtime,
    deliver: (input: TurnRequest) => runtime.runPromise(
      Effect.flatMap(DeliveryCoordinator, (coordinator) =>
        coordinator.deliver(input)),
    ),
    circuitState: (threadId: ThreadId) => runtime.runPromise(
      Effect.flatMap(DeliveryCoordinator, (coordinator) =>
        coordinator.circuitState(threadId)),
    ),
    resetCircuit: (threadId: ThreadId) => runtime.runPromise(
      Effect.flatMap(DeliveryCoordinator, (coordinator) =>
        coordinator.resetOpenDesktopCircuit(threadId)),
    ),
  };
}
