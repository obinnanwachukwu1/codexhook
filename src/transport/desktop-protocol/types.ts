export type DesktopProtocolOperation =
  | "initialize"
  | "follow-thread"
  | "load-history"
  | "start-turn"
  | "steer-turn";

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
  readonly resultType?: "error" | "success";
  readonly type: string;
  readonly version?: number;
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
  readonly adapterId: string;
  readonly fingerprint: DesktopProtocolFingerprint;
  readonly operation: DesktopProtocolOperation;
  readonly requestId: string;
  readonly outcome:
    | { readonly _tag: "Accepted"; readonly value: A }
    | {
        readonly _tag: "Rejected";
        readonly rejection: DesktopKnownRejection;
      };
}

export interface DesktopWriteReceipt {
  readonly adapterId: string;
  readonly fingerprint: DesktopProtocolFingerprint;
  readonly operation: "follow-thread";
  readonly writeState: "written";
}

export interface DesktopStartResult {
  readonly result: unknown;
  readonly turnId: string;
}

export interface DesktopSteerResult {
  readonly result: unknown;
  readonly turnId: string | null;
}

export type DesktopProtocolObservation =
  | {
      readonly _tag: "Connected" | "Reconnected";
      readonly profile: DesktopProtocolProfile;
    }
  | {
      readonly _tag: "Disconnected";
      readonly reason: "closed" | "socket-error" | "protocol-error";
    }
  | {
      readonly _tag: "OrphanResponse";
      readonly requestId: string;
    }
  | {
      readonly _tag: "MalformedBroadcast";
    };

export interface DesktopProtocolSessionOptions {
  readonly handshakeTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly maxRequestTimeoutMs?: number;
  readonly minRequestTimeoutMs?: number;
}
