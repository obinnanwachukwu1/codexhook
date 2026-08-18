import { Writable } from "node:stream";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  DeliveryCoordinator,
  DeliveryCoordinatorLive,
} from "../../src/delivery/coordinator.js";
import {
  type DeliveryEvidence,
  type DeliveryReceipt,
  type DesktopRouteState,
  DesktopSession,
  type DesktopSessionService,
  LocalCodexService,
  type LocalCodexServiceApi,
} from "../../src/delivery/routing-contracts.js";
import { Logger } from "../../src/logger.js";
import {
  DeliveryId,
  ThreadId,
  TurnId,
  type TurnRequest,
} from "../../src/types.js";

export interface CoordinatorRecorder {
  desktopEvidence: string[];
  desktopInjections: string[];
  localDeliveries: string[];
  reconciliations: Array<{ deliveryId: string; source: string }>;
}

export interface CoordinatorFixtureOptions {
  readonly routeState?: DesktopRouteState | ((request: ThreadId) => DesktopRouteState);
  readonly desktopReceipt?: DeliveryReceipt | ((request: TurnRequest) => Effect.Effect<DeliveryReceipt>);
  readonly desktopEvidence?: DeliveryEvidence | ((request: TurnRequest) => Effect.Effect<DeliveryEvidence>);
  readonly localReceipt?: DeliveryReceipt | ((request: TurnRequest) => Effect.Effect<DeliveryReceipt>);
  readonly canonicalEvidence?: DeliveryEvidence | ((request: TurnRequest, source: "desktop" | "app-server") => Effect.Effect<DeliveryEvidence>);
}

function valueEffect<A, B>(
  value: A | ((input: B) => Effect.Effect<A>),
  input: B,
): Effect.Effect<A> {
  return typeof value === "function"
    ? (value as (item: B) => Effect.Effect<A>)(input)
    : Effect.succeed(value);
}

export function request(
  deliveryId = "delivery-1",
  threadId = "thread-1",
): TurnRequest {
  return {
    threadId: ThreadId(threadId),
    deliveryId: DeliveryId(deliveryId),
    message: "private webhook body",
    mode: "queue",
    idleTimeout: "1 second",
    turnTimeout: "1 second",
  };
}

export function coordinatorFixture(options: CoordinatorFixtureOptions = {}) {
  const recorder: CoordinatorRecorder = {
    desktopEvidence: [],
    desktopInjections: [],
    localDeliveries: [],
    reconciliations: [],
  };
  const routeState = options.routeState ?? { _tag: "HealthyAttached" };
  const desktopReceipt = options.desktopReceipt ?? {
    _tag: "Acknowledged",
    turnId: TurnId("turn-1"),
  };
  const desktopEvidence = options.desktopEvidence ?? {
    _tag: "Found",
    turnId: TurnId("turn-1"),
  };
  const localReceipt = options.localReceipt ?? desktopReceipt;
  const canonicalEvidence = options.canonicalEvidence ?? desktopEvidence;

  const desktop: DesktopSessionService = {
    routeState: (threadId) => Effect.sync(() =>
      typeof routeState === "function" ? routeState(threadId) : routeState),
    inject: (input) => Effect.sync(() => {
      recorder.desktopInjections.push(input.deliveryId);
    }).pipe(Effect.zipRight(valueEffect(desktopReceipt, input))),
    evidence: (input) => Effect.sync(() => {
      recorder.desktopEvidence.push(input.deliveryId);
    }).pipe(Effect.zipRight(valueEffect(desktopEvidence, input))),
  };
  const local: LocalCodexServiceApi = {
    deliver: (input) => Effect.sync(() => {
      recorder.localDeliveries.push(input.deliveryId);
    }).pipe(Effect.zipRight(valueEffect(localReceipt, input))),
    reconcile: (input, source) => Effect.sync(() => {
      recorder.reconciliations.push({
        deliveryId: input.deliveryId,
        source,
      });
    }).pipe(
      Effect.zipRight(
        typeof canonicalEvidence === "function"
          ? canonicalEvidence(input, source)
          : Effect.succeed(canonicalEvidence),
      ),
    ),
  };
  const logger = new Logger(new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }));
  const dependencies = Layer.merge(
    Layer.succeed(DesktopSession, DesktopSession.of(desktop)),
    Layer.succeed(LocalCodexService, LocalCodexService.of(local)),
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
  };
}
