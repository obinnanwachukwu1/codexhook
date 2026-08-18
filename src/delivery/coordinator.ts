import { Context, Effect, Exit, Layer } from "effect";
import { Logger } from "../logger.js";
import type { ThreadId, TurnRequest } from "../types.js";
import { boundedEvidence, boundedReceipt, boundedRouteState, INTERNAL } from "./bounded.js";
import {
  decideDesktopEvidence,
  unsettledWriteDiagnostic,
} from "./coordinator-policy.js";
import {
  CanonicalDeliveryPort,
  type CoordinatedDeliveryResult,
  type DeliveryProof,
  type DeliveryReceipt,
  type DeliveryRef,
  type DesktopCircuitState,
  DesktopDeliveryPort,
  type DesktopWriteReceipt,
  type RoutingDiagnostic,
  WRITE_AMBIGUOUS,
} from "./routing-contracts.js";

export interface DeliveryCoordinatorService {
  /** Concurrent same-task calls are supported; writes are serialized per task. */
  readonly deliver: (
    request: TurnRequest,
  ) => Effect.Effect<CoordinatedDeliveryResult>;
  readonly circuitState: (
    threadId: ThreadId,
  ) => Effect.Effect<DesktopCircuitState>;
  /** A health transition may close an Open circuit, never an in-flight one. */
  readonly resetOpenDesktopCircuit: (
    threadId: ThreadId,
  ) => Effect.Effect<void>;
}

export class DeliveryCoordinator extends Context.Tag(
  "codexhook/DeliveryCoordinator",
)<DeliveryCoordinator, DeliveryCoordinatorService>() {}

interface DesktopReconciliation {
  readonly _tag: "ReconcileDesktop";
  readonly receipt: DesktopWriteReceipt;
}

type RoutePlan =
  | DesktopReconciliation
  | {
      readonly _tag: "DirectAppServer";
      readonly desktopReceipt: DeliveryReceipt | null;
    }
  | {
      readonly _tag: "DesktopRejected";
      readonly receipt: Extract<DeliveryReceipt, { readonly _tag: "Rejected" }>;
    };

const EMPTY_PROOF: DeliveryProof = {
  desktopReceipt: null,
  desktopEvidence: null,
  canonicalAfterDesktop: null,
  appServerReceipt: null,
  canonicalAfterAppServer: null,
};

function reference(request: TurnRequest): DeliveryRef {
  return {
    deliveryId: request.deliveryId,
    threadId: request.threadId,
  };
}

interface TaskGate {
  readonly semaphore: Effect.Semaphore;
  users: number;
}

export function DeliveryCoordinatorLive(
  logger: Logger,
): Layer.Layer<
  DeliveryCoordinator,
  never,
  DesktopDeliveryPort | CanonicalDeliveryPort
> {
  return Layer.effect(
    DeliveryCoordinator,
    Effect.gen(function* () {
      const desktop = yield* DesktopDeliveryPort;
      const local = yield* CanonicalDeliveryPort;
      const gates = new Map<ThreadId, TaskGate>();
      type ActiveCircuit = Exclude<DesktopCircuitState, { _tag: "Closed" }>;
      const circuits = new Map<ThreadId, ActiveCircuit>();

      const acquireGate = (threadId: ThreadId): Effect.Effect<TaskGate> =>
        Effect.sync(() => {
          let gate = gates.get(threadId);
          if (gate == null) {
            gate = { semaphore: Effect.unsafeMakeSemaphore(1), users: 0 };
            gates.set(threadId, gate);
          }
          gate.users += 1;
          return gate;
        });

      const releaseGate = (threadId: ThreadId, gate: TaskGate) =>
        Effect.sync(() => {
          gate.users -= 1;
          if (gate.users === 0) gates.delete(threadId);
        });

      const markReconciling = (delivery: DeliveryRef): void => {
        circuits.set(delivery.threadId, {
          _tag: "Reconciling",
          deliveryId: delivery.deliveryId,
        });
      };

      const openDesktopCircuit = (
        delivery: DeliveryRef,
        diagnostic: RoutingDiagnostic,
      ): void => {
        circuits.set(delivery.threadId, {
          _tag: "Open",
          deliveryId: delivery.deliveryId,
          diagnostic,
        });
        logger.warn("desktop_delivery_circuit_opened", {
          deliveryId: delivery.deliveryId,
          threadId: delivery.threadId,
          diagnosticCode: diagnostic.code,
        });
      };

      const closeIfOwnedBy = (delivery: DeliveryRef): void => {
        const current = circuits.get(delivery.threadId);
        if (current?._tag === "Reconciling" &&
            current.deliveryId === delivery.deliveryId) {
          circuits.delete(delivery.threadId);
        }
      };

      const submitAppServer = (
        request: TurnRequest,
        gate: TaskGate,
        prior: Pick<
          DeliveryProof,
          "desktopReceipt" | "desktopEvidence" | "canonicalAfterDesktop"
        >,
      ): Effect.Effect<CoordinatedDeliveryResult> =>
        Effect.gen(function* () {
          const delivery = reference(request);
          const receipt = yield* gate.semaphore.withPermits(1)(
            boundedReceipt(local.deliver(request), request.turnTimeout),
          );
          const proof: DeliveryProof = {
            ...prior,
            appServerReceipt: receipt,
            canonicalAfterAppServer: null,
          };
          // App-server is canonical, so its acknowledgement needs no barrier.
          if (receipt._tag === "Acknowledged") {
            return {
              ...delivery,
              _tag: "ConfirmedAppServer",
              turnId: receipt.turnId,
              proof,
            } as const;
          }
          if (receipt._tag === "Rejected") {
            return {
              ...delivery,
              _tag: "Rejected",
              route: "app-server",
              diagnostic: receipt.diagnostic,
              proof,
            };
          }
          if (receipt._tag === "NotSubmitted") {
            return {
              ...delivery,
              _tag: "Unavailable",
              diagnostic: receipt.diagnostic,
              proof,
            };
          }
          const canonical = yield* boundedEvidence(
            local.reconcile(delivery),
            request.turnTimeout,
          );
          const reconciled: DeliveryProof = {
            ...proof,
            canonicalAfterAppServer: canonical,
          };
          if (canonical._tag === "Found") {
            return {
              ...delivery,
              _tag: "ConfirmedAppServer",
              turnId: canonical.turnId,
              proof: reconciled,
            };
          }
          if (canonical._tag === "Absent") {
            const unsettled = unsettledWriteDiagnostic(receipt);
            if (unsettled != null) {
              return {
                ...delivery,
                _tag: "Ambiguous",
                route: "app-server",
                diagnostic: unsettled,
                proof: reconciled,
              } as const;
            }
            return {
              ...delivery,
              _tag: "Unavailable",
              diagnostic: receipt.diagnostic,
              proof: reconciled,
            };
          }
          // App-server ambiguity does not implicate desktop health. Keeping its
          // circuit closed preserves the preferred route for a later command.
          return {
            ...delivery,
            _tag: "Ambiguous",
            route: "app-server",
            diagnostic: canonical.diagnostic,
            proof: reconciled,
          };
        });

      const attemptDesktopRoute = (
        request: TurnRequest,
      ): Effect.Effect<RoutePlan> =>
        Effect.gen(function* () {
          const delivery = reference(request);
          if (circuits.has(request.threadId)) {
            return { _tag: "DirectAppServer", desktopReceipt: null };
          }
          const state = yield* boundedRouteState(
            desktop.routeState(request.threadId),
            request.turnTimeout,
          );
          // Keep these states distinct: public adapters retain why desktop was
          // skipped even though both states currently route through app-server.
          if (state._tag !== "HealthyAttached") {
            return { _tag: "DirectAppServer", desktopReceipt: null };
          }
          markReconciling(delivery);
          const receipt = yield* boundedReceipt(
            desktop.inject(request),
            request.turnTimeout,
          );
          if (receipt._tag === "Rejected") {
            closeIfOwnedBy(delivery);
            return {
              _tag: "DesktopRejected",
              receipt,
            };
          }
          if (receipt._tag === "NotSubmitted") {
            closeIfOwnedBy(delivery);
            return { _tag: "DirectAppServer", desktopReceipt: receipt };
          }
          return { _tag: "ReconcileDesktop", receipt };
        });

      const reconcileDesktop = (
        request: TurnRequest,
        gate: TaskGate,
        receipt: DesktopReconciliation["receipt"],
      ): Effect.Effect<CoordinatedDeliveryResult> => {
        const delivery = reference(request);
        return Effect.gen(function* () {
          const [desktopEvidence, canonical] = yield* Effect.all(
            [
              boundedEvidence(desktop.evidence(delivery), request.turnTimeout),
              boundedEvidence(
                local.reconcile(delivery),
                request.turnTimeout,
              ),
            ],
            { concurrency: "unbounded" },
          );
          const proof: DeliveryProof = {
            desktopReceipt: receipt,
            desktopEvidence,
            canonicalAfterDesktop: canonical,
            appServerReceipt: null,
            canonicalAfterAppServer: null,
          };
          const decision = decideDesktopEvidence(
            receipt,
            desktopEvidence,
            canonical,
          );
          if (decision._tag === "Confirm") {
            closeIfOwnedBy(delivery);
            return {
              ...delivery,
              _tag: "ConfirmedDesktop",
              turnId: decision.turnId,
              proof,
            } as const;
          }
          if (decision._tag === "Fallback") {
            if (receipt._tag === "Acknowledged" ||
                desktopEvidence._tag === "Found") {
              openDesktopCircuit(delivery, WRITE_AMBIGUOUS);
            } else {
              closeIfOwnedBy(delivery);
            }
            return yield* submitAppServer(request, gate, {
              desktopReceipt: receipt,
              desktopEvidence,
              canonicalAfterDesktop: canonical,
            });
          }
          openDesktopCircuit(delivery, decision.diagnostic);
          return {
            ...delivery,
            _tag: "Ambiguous",
            route: "desktop",
            diagnostic: decision.diagnostic,
            proof,
          } as const;
        });
      };

      const deliver = (request: TurnRequest) => {
        const delivery = reference(request);
        const coordinated = Effect.acquireUseRelease(
          acquireGate(request.threadId),
          (gate) => Effect.gen(function* () {
            const plan = yield* gate.semaphore.withPermits(1)(
              attemptDesktopRoute(request),
            );
            if (plan._tag === "DesktopRejected") {
              return {
                ...delivery,
                _tag: "Rejected",
                route: "desktop",
                diagnostic: plan.receipt.diagnostic,
                proof: { ...EMPTY_PROOF, desktopReceipt: plan.receipt },
              } as const;
            }
            if (plan._tag === "DirectAppServer") {
              return yield* submitAppServer(request, gate, {
                desktopReceipt: plan.desktopReceipt,
                desktopEvidence: null,
                canonicalAfterDesktop: null,
              });
            }
            return yield* reconcileDesktop(request, gate, plan.receipt);
          }).pipe(
            Effect.onExit((exit) => Effect.sync(() => {
              if (!Exit.isSuccess(exit)) {
                const current = circuits.get(delivery.threadId);
                if (current?._tag === "Reconciling" &&
                  current.deliveryId === delivery.deliveryId) {
                  openDesktopCircuit(delivery, WRITE_AMBIGUOUS);
                }
              }
            })),
          ),
          (gate) => releaseGate(request.threadId, gate),
        );
        return coordinated.pipe(
          Effect.catchAllDefect(() => Effect.sync(() => {
            const current = circuits.get(delivery.threadId);
            if (current?.deliveryId === delivery.deliveryId) {
              return {
                ...delivery,
                _tag: "Ambiguous",
                route: "desktop",
                diagnostic: INTERNAL,
                proof: EMPTY_PROOF,
              } as const;
            }
            return {
              ...delivery,
              _tag: "Unavailable",
              diagnostic: INTERNAL,
              proof: EMPTY_PROOF,
            } as const;
          })),
        );
      };

      return DeliveryCoordinator.of({
        deliver,
        circuitState: (threadId) => Effect.sync(() =>
          circuits.get(threadId) ?? { _tag: "Closed" as const }),
        resetOpenDesktopCircuit: (threadId) => Effect.sync(() => {
          if (circuits.get(threadId)?._tag === "Open") {
            circuits.delete(threadId);
          }
        }),
      });
    }),
  );
}
