import { Context, Effect, Layer } from "effect";
import { Logger } from "../logger.js";
import type { ThreadId, TurnRequest } from "../types.js";
import {
  type CoordinatedDeliveryResult,
  type DeliveryEvidence,
  type DeliveryProof,
  type DeliveryReceipt,
  type DesktopCircuitState,
  DesktopSession,
  LocalCodexService,
} from "./routing-contracts.js";

export interface DeliveryCoordinatorService {
  readonly deliver: (
    request: TurnRequest,
  ) => Effect.Effect<CoordinatedDeliveryResult>;
  readonly circuitState: (
    threadId: ThreadId,
  ) => Effect.Effect<DesktopCircuitState>;
  /** Called only after an attachment transition has independently proven health. */
  readonly resetDesktopCircuit: (threadId: ThreadId) => Effect.Effect<void>;
}

export class DeliveryCoordinator extends Context.Tag(
  "codexhook/DeliveryCoordinator",
)<DeliveryCoordinator, DeliveryCoordinatorService>() {}

interface DesktopReconciliation {
  readonly _tag: "ReconcileDesktop";
  readonly receipt: Extract<
    DeliveryReceipt,
    { readonly _tag: "Acknowledged" | "Uncertain" }
  >;
}

interface DirectAppServer {
  readonly _tag: "DirectAppServer";
  readonly desktopReceipt: DeliveryReceipt | null;
  readonly desktopEvidence: DeliveryEvidence | null;
  readonly canonicalEvidence: DeliveryEvidence | null;
}

type RoutePlan =
  | DesktopReconciliation
  | DirectAppServer
  | { readonly _tag: "Terminal"; readonly result: CoordinatedDeliveryResult };

const emptyProof = (): DeliveryProof => ({
  desktopReceipt: null,
  appServerReceipt: null,
  desktopEvidence: null,
  canonicalEvidence: null,
});

function base(request: TurnRequest) {
  return {
    deliveryId: request.deliveryId,
    threadId: request.threadId,
  } as const;
}

function evidenceConflict(
  receipt: DeliveryReceipt,
  desktop: DeliveryEvidence,
  canonical: Extract<DeliveryEvidence, { readonly _tag: "Found" }>,
): string | null {
  if (receipt._tag === "Acknowledged" && receipt.turnId !== canonical.turnId) {
    return "desktop receipt and canonical evidence identify different turns";
  }
  if (desktop._tag === "Found" && desktop.turnId !== canonical.turnId) {
    return "desktop state and canonical evidence identify different turns";
  }
  return null;
}

export function DeliveryCoordinatorLive(
  logger = new Logger(),
): Layer.Layer<DeliveryCoordinator, never, DesktopSession | LocalCodexService> {
  return Layer.effect(
    DeliveryCoordinator,
    Effect.gen(function* () {
      const desktop = yield* DesktopSession;
      const local = yield* LocalCodexService;
      const gateCreation = yield* Effect.makeSemaphore(1);
      const gates = new Map<ThreadId, Effect.Semaphore>();
      const circuits = new Map<ThreadId, Exclude<DesktopCircuitState, { _tag: "Closed" }>>();

      const gateFor = (threadId: ThreadId) =>
        gateCreation.withPermits(1)(
          Effect.gen(function* () {
            const existing = gates.get(threadId);
            if (existing != null) return existing;
            const created = yield* Effect.makeSemaphore(1);
            gates.set(threadId, created);
            return created;
          }),
        );

      const open = (
        request: TurnRequest,
        detail: string,
      ): void => {
        circuits.set(request.threadId, {
          _tag: "Open",
          deliveryId: request.deliveryId,
          detail,
        });
        logger.warn("desktop_delivery_circuit_opened", {
          deliveryId: request.deliveryId,
          threadId: request.threadId,
          detail,
        });
      };

      const submitAppServer = (
        request: TurnRequest,
        prior: Omit<DeliveryProof, "appServerReceipt">,
      ): Effect.Effect<CoordinatedDeliveryResult> =>
        Effect.gen(function* () {
          const receipt = yield* local.deliver(request);
          const proof = { ...prior, appServerReceipt: receipt };
          if (receipt._tag === "Acknowledged") {
            return {
              ...base(request),
              _tag: "ConfirmedAppServer",
              route: "app-server",
              turnId: receipt.turnId,
              proof,
            };
          }
          if (receipt._tag === "Rejected" || receipt._tag === "RejectedBeforeWrite") {
            return {
              ...base(request),
              _tag: "Rejected",
              route: "app-server",
              detail: receipt.detail,
              proof,
            };
          }
          if (receipt._tag === "UnavailableBeforeWrite") {
            return {
              ...base(request),
              _tag: "Unavailable",
              route: "app-server",
              detail: receipt.detail,
              proof,
            };
          }
          const canonical = yield* local.reconcile(request, "app-server");
          const reconciledProof = { ...proof, canonicalEvidence: canonical };
          if (canonical._tag === "Found") {
            return {
              ...base(request),
              _tag: "ConfirmedAppServer",
              route: "app-server",
              turnId: canonical.turnId,
              proof: reconciledProof,
            };
          }
          if (canonical._tag === "Absent") {
            return {
              ...base(request),
              _tag: "Unavailable",
              route: "app-server",
              detail: canonical.detail,
              proof: reconciledProof,
            };
          }
          return {
            ...base(request),
            _tag: "Ambiguous",
            route: "app-server",
            detail: canonical.detail,
            proof: reconciledProof,
          };
        });

      const chooseRoute = (request: TurnRequest): Effect.Effect<RoutePlan> =>
        Effect.gen(function* () {
          if (circuits.has(request.threadId)) {
            return {
              _tag: "DirectAppServer",
              desktopReceipt: null,
              desktopEvidence: null,
              canonicalEvidence: null,
            };
          }
          const state = yield* desktop.routeState(request.threadId);
          if (state._tag !== "HealthyAttached") {
            return {
              _tag: "DirectAppServer",
              desktopReceipt: null,
              desktopEvidence: null,
              canonicalEvidence: null,
            };
          }
          const receipt = yield* desktop.inject(request);
          if (receipt._tag === "Rejected") {
            return {
              _tag: "Terminal",
              result: {
                ...base(request),
                _tag: "Rejected",
                route: "desktop",
                detail: receipt.detail,
                proof: { ...emptyProof(), desktopReceipt: receipt },
              },
            };
          }
          if (receipt._tag === "RejectedBeforeWrite" ||
              receipt._tag === "UnavailableBeforeWrite") {
            return {
              _tag: "DirectAppServer",
              desktopReceipt: receipt,
              desktopEvidence: null,
              canonicalEvidence: null,
            };
          }
          circuits.set(request.threadId, {
            _tag: "Reconciling",
            deliveryId: request.deliveryId,
          });
          return { _tag: "ReconcileDesktop", receipt };
        });

      const reconcileDesktop = (
        request: TurnRequest,
        receipt: DesktopReconciliation["receipt"],
      ): Effect.Effect<CoordinatedDeliveryResult> =>
        Effect.gen(function* () {
          const [desktopEvidence, canonical] = yield* Effect.all(
            [desktop.evidence(request), local.reconcile(request, "desktop")],
            { concurrency: "unbounded" },
          );
          const proof: DeliveryProof = {
            desktopReceipt: receipt,
            appServerReceipt: null,
            desktopEvidence,
            canonicalEvidence: canonical,
          };
          if (canonical._tag === "Found") {
            const conflict = evidenceConflict(receipt, desktopEvidence, canonical);
            if (conflict != null) {
              open(request, conflict);
              return {
                ...base(request),
                _tag: "Ambiguous",
                route: "desktop",
                detail: conflict,
                proof,
              };
            }
            const current = circuits.get(request.threadId);
            if (current?._tag === "Reconciling" &&
                current.deliveryId === request.deliveryId) {
              circuits.delete(request.threadId);
            }
            return {
              ...base(request),
              _tag: "ConfirmedDesktop",
              route: "desktop",
              turnId: canonical.turnId,
              proof,
            };
          }
          if (canonical._tag === "Absent") {
            open(request, "desktop write proven absent from canonical store");
            return yield* submitAppServer(request, {
              desktopReceipt: receipt,
              desktopEvidence,
              canonicalEvidence: canonical,
            });
          }
          open(request, canonical.detail);
          return {
            ...base(request),
            _tag: "Ambiguous",
            route: "desktop",
            detail: canonical.detail,
            proof,
          };
        });

      const deliver = (request: TurnRequest) =>
        Effect.gen(function* () {
          const gate = yield* gateFor(request.threadId);
          const plan = yield* gate.withPermits(1)(chooseRoute(request));
          if (plan._tag === "Terminal") return plan.result;
          if (plan._tag === "DirectAppServer") {
            return yield* submitAppServer(request, {
              desktopReceipt: plan.desktopReceipt,
              desktopEvidence: plan.desktopEvidence,
              canonicalEvidence: plan.canonicalEvidence,
            });
          }
          return yield* reconcileDesktop(request, plan.receipt);
        });

      return DeliveryCoordinator.of({
        deliver,
        circuitState: (threadId) => Effect.sync(() =>
          circuits.get(threadId) ?? { _tag: "Closed" as const }),
        resetDesktopCircuit: (threadId) => Effect.sync(() => {
          circuits.delete(threadId);
        }),
      });
    }),
  );
}
