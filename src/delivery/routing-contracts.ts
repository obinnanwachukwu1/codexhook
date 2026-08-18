import { Context, type Effect } from "effect";
import type {
  DeliveryId,
  ThreadId,
  TurnId,
  TurnRequest,
} from "../types.js";

export type DesktopRouteState =
  | { readonly _tag: "HealthyAttached" }
  | { readonly _tag: "Unattached"; readonly detail: string }
  | { readonly _tag: "Unhealthy"; readonly detail: string };

/**
 * A receipt describes only what the selected transport can prove about its
 * write. It deliberately does not imply that the canonical local store
 * contains the command.
 */
export type DeliveryReceipt =
  | { readonly _tag: "Acknowledged"; readonly turnId: TurnId }
  | { readonly _tag: "RejectedBeforeWrite"; readonly detail: string }
  | { readonly _tag: "UnavailableBeforeWrite"; readonly detail: string }
  | { readonly _tag: "Rejected"; readonly detail: string }
  | { readonly _tag: "Uncertain"; readonly detail: string };

export type DeliveryEvidence =
  | { readonly _tag: "Found"; readonly turnId: TurnId }
  | { readonly _tag: "Absent"; readonly detail: string }
  | { readonly _tag: "Unresolved"; readonly detail: string };

export type DeliveryRoute = "desktop" | "app-server";

export interface DeliveryProof {
  readonly desktopReceipt: DeliveryReceipt | null;
  readonly appServerReceipt: DeliveryReceipt | null;
  readonly desktopEvidence: DeliveryEvidence | null;
  readonly canonicalEvidence: DeliveryEvidence | null;
}

interface DeliveryResultBase {
  readonly deliveryId: DeliveryId;
  readonly threadId: ThreadId;
  readonly proof: DeliveryProof;
}

export type CoordinatedDeliveryResult =
  | (DeliveryResultBase & {
      readonly _tag: "ConfirmedDesktop";
      readonly route: "desktop";
      readonly turnId: TurnId;
    })
  | (DeliveryResultBase & {
      readonly _tag: "ConfirmedAppServer";
      readonly route: "app-server";
      readonly turnId: TurnId;
    })
  | (DeliveryResultBase & {
      readonly _tag: "Ambiguous";
      readonly route: DeliveryRoute;
      readonly detail: string;
    })
  | (DeliveryResultBase & {
      readonly _tag: "Unavailable";
      readonly route: "app-server";
      readonly detail: string;
    })
  | (DeliveryResultBase & {
      readonly _tag: "Rejected";
      readonly route: DeliveryRoute;
      readonly detail: string;
    });

export interface DesktopSessionService {
  readonly routeState: (
    threadId: ThreadId,
  ) => Effect.Effect<DesktopRouteState>;
  readonly inject: (
    request: TurnRequest,
  ) => Effect.Effect<DeliveryReceipt>;
  readonly evidence: (
    request: TurnRequest,
  ) => Effect.Effect<DeliveryEvidence>;
}

export class DesktopSession extends Context.Tag(
  "codexhook/DesktopSession",
)<DesktopSession, DesktopSessionService>() {}

export interface LocalCodexServiceApi {
  readonly deliver: (
    request: TurnRequest,
  ) => Effect.Effect<DeliveryReceipt>;
  readonly reconcile: (
    request: TurnRequest,
    source: DeliveryRoute,
  ) => Effect.Effect<DeliveryEvidence>;
}

export class LocalCodexService extends Context.Tag(
  "codexhook/LocalCodexService",
)<LocalCodexService, LocalCodexServiceApi>() {}

export type DesktopCircuitState =
  | { readonly _tag: "Closed" }
  | {
      readonly _tag: "Reconciling";
      readonly deliveryId: DeliveryId;
    }
  | {
      readonly _tag: "Open";
      readonly deliveryId: DeliveryId;
      readonly detail: string;
    };
