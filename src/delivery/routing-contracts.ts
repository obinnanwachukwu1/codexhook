import { Context, type Effect } from "effect";
import type {
  DeliveryId,
  ThreadId,
  TurnId,
  TurnRequest,
} from "../types.js";

export type RoutingDiagnosticCode =
  | "desktop-unavailable"
  | "desktop-incompatible"
  | "app-server-unavailable"
  | "app-server-incompatible"
  | "task-not-found"
  | "write-ambiguous"
  | "request-rejected"
  | "timeout"
  | "disconnected"
  | "internal";

/** Closed, content-free diagnostic safe for logs and result metadata. */
export interface RoutingDiagnostic {
  readonly code: RoutingDiagnosticCode;
}

export interface DeliveryRef {
  readonly threadId: ThreadId;
  readonly deliveryId: DeliveryId;
}

export type DesktopRouteState =
  | { readonly _tag: "HealthyAttached" }
  | { readonly _tag: "Unattached" }
  | { readonly _tag: "Unhealthy" };

/** Desktop acknowledgement is a receipt; app-server acknowledgement is canonical. */
export type DeliveryReceipt =
  | { readonly _tag: "Acknowledged"; readonly turnId: TurnId }
  | { readonly _tag: "NotSubmitted"; readonly diagnostic: RoutingDiagnostic }
  | { readonly _tag: "Rejected"; readonly diagnostic: RoutingDiagnostic }
  | { readonly _tag: "Uncertain"; readonly diagnostic: RoutingDiagnostic };

export type DeliveryEvidence =
  | { readonly _tag: "Found"; readonly turnId: TurnId }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Unresolved"; readonly diagnostic: RoutingDiagnostic };

export type DeliveryRoute = "desktop" | "app-server";

export interface DeliveryProof {
  readonly desktopReceipt: DeliveryReceipt | null;
  readonly desktopEvidence: DeliveryEvidence | null;
  readonly canonicalAfterDesktop: DeliveryEvidence | null;
  readonly appServerReceipt: DeliveryReceipt | null;
  readonly canonicalAfterAppServer: DeliveryEvidence | null;
}

interface DeliveryResultBase extends DeliveryRef {
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
      readonly diagnostic: RoutingDiagnostic;
    })
  | (DeliveryResultBase & {
      readonly _tag: "Unavailable";
      readonly route: "app-server";
      readonly diagnostic: RoutingDiagnostic;
    })
  | (DeliveryResultBase & {
      readonly _tag: "Rejected";
      readonly route: DeliveryRoute;
      readonly diagnostic: RoutingDiagnostic;
    });

/** Internal adapter port. PR #8 owns the eventual public Desktop contracts. */
export interface DesktopDeliveryPortService {
  readonly routeState: (
    threadId: ThreadId,
  ) => Effect.Effect<DesktopRouteState>;
  readonly inject: (
    request: TurnRequest,
  ) => Effect.Effect<DeliveryReceipt>;
  readonly evidence: (
    delivery: DeliveryRef,
  ) => Effect.Effect<DeliveryEvidence>;
}

export class DesktopDeliveryPort extends Context.Tag(
  "codexhook/DesktopDeliveryPort",
)<DesktopDeliveryPort, DesktopDeliveryPortService>() {}

/** Internal adapter port. PR #8 owns the eventual public LocalCodexService. */
export interface CanonicalDeliveryPortService {
  readonly deliver: (
    request: TurnRequest,
  ) => Effect.Effect<DeliveryReceipt>;
  readonly reconcile: (
    delivery: DeliveryRef,
    source: DeliveryRoute,
  ) => Effect.Effect<DeliveryEvidence>;
}

export class CanonicalDeliveryPort extends Context.Tag(
  "codexhook/CanonicalDeliveryPort",
)<CanonicalDeliveryPort, CanonicalDeliveryPortService>() {}

export type DesktopCircuitState =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Reconciling"; readonly deliveryId: DeliveryId }
  | {
      readonly _tag: "Open";
      readonly deliveryId: DeliveryId;
      readonly diagnostic: RoutingDiagnostic;
    };
