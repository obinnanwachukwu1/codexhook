import type { Socket } from "node:net";

export type DesktopRequestOperation =
  | "load-history"
  | "start-turn"
  | "steer-turn";

export type DesktopProtocolOperation =
  | "follow-thread"
  | DesktopRequestOperation;

export type DesktopProtocolCapability =
  | "completeHistory"
  | "startTurn"
  | "steerTurn"
  | "threadStream";

export interface DesktopCapabilities {
  readonly source: "advertised" | "legacy-inferred";
  readonly completeHistory: boolean;
  readonly startTurn: boolean;
  readonly steerTurn: boolean;
  readonly threadStream: boolean;
}

export interface DesktopProtocolFingerprint {
  readonly adapterId: string;
  readonly appVersion: string | null;
  readonly buildNumber: string | null;
  readonly digest: string;
  readonly protocolVersion: number | null;
}

export interface DesktopProtocolProfile {
  readonly capabilities: DesktopCapabilities;
  readonly fingerprint: DesktopProtocolFingerprint;
}

export interface DesktopWireEnvelope {
  readonly error?: unknown;
  readonly method?: string;
  readonly params?: unknown;
  readonly requestId?: string;
  readonly result?: unknown;
  readonly resultType?: string;
  readonly type: string;
  readonly version?: number;
}

export interface DesktopResponseEnvelope extends DesktopWireEnvelope {
  readonly requestId: string;
  readonly type: "response";
}

export type DesktopKnownRejection =
  | "client-cannot-handle-request"
  | "client-not-found"
  | "no-client-found"
  | "no-handler-for-request"
  | "request-version-mismatch"
  | "thread-role-timeout"
  | "thread-stream-owner-unavailable"
  | "unknown";

export interface DesktopRequestReceipt<A> {
  readonly fingerprint: DesktopProtocolFingerprint;
  readonly operation: DesktopRequestOperation;
  readonly requestId: string;
  readonly outcome:
    | { readonly _tag: "Accepted"; readonly value: A }
    | {
        readonly _tag: "Rejected";
        readonly rejection: DesktopKnownRejection;
      };
}

export interface DesktopWriteReceipt {
  readonly fingerprint: DesktopProtocolFingerprint;
  readonly operation: "follow-thread";
  readonly writeState: "written";
}

export interface DesktopStartResult {
  readonly turnId: string;
}

export interface DesktopSteerResult {
  readonly turnId: string | null;
}

export type DesktopProtocolObservation =
  | {
      readonly _tag: "Reconnected" | "Reconnecting";
      readonly profile: DesktopProtocolProfile;
    }
  | {
      readonly _tag: "Disconnected";
      readonly reason: "closed" | "socket-error" | "protocol-error";
    }
  | {
      readonly _tag: "OrphanResponse";
    }
  | {
      readonly _tag: "MalformedBroadcast";
    }
  | {
      readonly _tag: "MalformedEnvelope";
    };

export interface DesktopProtocolSessionOptions {
  /** Internal test seam; production uses net.createConnection. */
  readonly createConnection?: () => Socket;
  readonly handshakeTimeoutMs?: number;
  readonly maxInboundFrameBytes?: number;
  readonly maxOutboundFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly maxRequestTimeoutMs?: number;
  readonly minRequestTimeoutMs?: number;
}
