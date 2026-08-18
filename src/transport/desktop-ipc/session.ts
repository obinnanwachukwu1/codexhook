import {
  decodeDesktopHandshake,
  DESKTOP_INITIALIZE_PARAMS,
  fingerprintDesktopProtocol,
  normalizeDesktopRejection,
  selectDesktopAdapter,
  type DesktopProtocolAdapter,
} from "./adapters.js";
import { DesktopProtocolError } from "./errors.js";
import {
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
} from "./framing.js";
import type {
  DesktopProtocolCapability,
  DesktopProtocolObservation,
  DesktopProtocolProfile,
  DesktopProtocolSessionOptions,
  DesktopRequestReceipt,
  DesktopResponseEnvelope,
  DesktopStartResult,
  DesktopSteerResult,
  DesktopWireEnvelope,
  DesktopWriteReceipt,
} from "./types.js";
import {
  desktopEndpointIdentity,
  RawDesktopConnection,
  type DesktopBroadcastListener,
  type DesktopObservationListener,
  type DesktopWireLimits,
} from "./wire.js";

const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MIN_REQUEST_TIMEOUT_MS = 10;

interface SessionLimits extends DesktopWireLimits {
  readonly handshakeTimeoutMs: number;
}

interface NegotiatedConnection {
  readonly adapter: DesktopProtocolAdapter;
  readonly profile: DesktopProtocolProfile;
  readonly raw: RawDesktopConnection;
}

function limits(options: DesktopProtocolSessionOptions): SessionLimits {
  return {
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
    maxInboundFrameBytes:
      options.maxInboundFrameBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES,
    maxOutboundFrameBytes:
      options.maxOutboundFrameBytes ?? DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
    maxPendingRequests:
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
    maxRequestTimeoutMs:
      options.maxRequestTimeoutMs ?? DEFAULT_MAX_REQUEST_TIMEOUT_MS,
    minRequestTimeoutMs:
      options.minRequestTimeoutMs ?? DEFAULT_MIN_REQUEST_TIMEOUT_MS,
  };
}

export class DesktopProtocolSession {
  private readonly broadcasts = new Set<DesktopBroadcastListener>();
  private closing = false;
  private connection: NegotiatedConnection | null = null;
  private readonly followedThreads = new Set<string>();
  private readonly limits: SessionLimits;
  private readonly observations = new Set<DesktopObservationListener>();
  private reconnecting: Promise<NegotiatedConnection> | null = null;

  private constructor(
    private readonly socketPath: string,
    options: DesktopProtocolSessionOptions,
  ) {
    this.limits = limits(options);
  }

  static async connect(
    socketPath: string,
    options: DesktopProtocolSessionOptions = {},
  ): Promise<DesktopProtocolSession> {
    const session = new DesktopProtocolSession(socketPath, options);
    session.connection = await session.open(false);
    return session;
  }

  static async probe(
    socketPath: string,
    options: DesktopProtocolSessionOptions = {},
  ): Promise<DesktopProtocolProfile> {
    const session = await DesktopProtocolSession.connect(socketPath, options);
    try {
      return session.profile;
    } finally {
      session.close();
    }
  }

  get alive(): boolean {
    return !this.closing && this.connection?.raw.alive === true;
  }

  get profile(): DesktopProtocolProfile {
    if (this.connection == null) {
      throw new DesktopProtocolError(
        "closed",
        "operation",
        "not-written",
        "Desktop IPC session has no negotiated connection",
      );
    }
    return this.connection.profile;
  }

  close(): void {
    this.closing = true;
    this.connection?.raw.close();
    this.connection = null;
  }

  onBroadcast(listener: DesktopBroadcastListener): () => void {
    this.broadcasts.add(listener);
    return () => this.broadcasts.delete(listener);
  }

  onObservation(listener: DesktopObservationListener): () => void {
    this.observations.add(listener);
    return () => this.observations.delete(listener);
  }

  async followThread(threadId: string): Promise<DesktopWriteReceipt> {
    const connection = await this.ready("threadStream");
    await connection.raw.broadcast(
      connection.adapter.methods.follow,
      connection.adapter.followParams(threadId),
      connection.adapter.version,
    );
    this.followedThreads.add(threadId);
    return {
      fingerprint: connection.profile.fingerprint,
      operation: "follow-thread",
      writeState: "written",
    };
  }

  async loadCompleteHistory(
    threadId: string,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<void>> {
    const connection = await this.ready("completeHistory");
    const response = await connection.raw.request(
      connection.adapter.methods.history,
      connection.adapter.historyParams(threadId),
      connection.adapter.version,
      timeoutMs,
    );
    return this.receipt(
      connection,
      "load-history",
      response,
      () => undefined,
    );
  }

  async startTurn(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<DesktopStartResult>> {
    const connection = await this.ready("startTurn");
    const response = await connection.raw.request(
      connection.adapter.methods.start,
      connection.adapter.startParams(threadId, params),
      connection.adapter.version,
      timeoutMs,
    );
    return this.receipt(
      connection,
      "start-turn",
      response,
      (value) => connection.adapter.decodeStart(value),
    );
  }

  async steerTurn(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<DesktopSteerResult>> {
    const connection = await this.ready("steerTurn");
    const response = await connection.raw.request(
      connection.adapter.methods.steer,
      connection.adapter.steerParams(threadId, params),
      connection.adapter.version,
      timeoutMs,
    );
    return this.receipt(
      connection,
      "steer-turn",
      response,
      (value) => connection.adapter.decodeSteer(value),
    );
  }

  private receipt<A>(
    connection: NegotiatedConnection,
    operation: DesktopRequestReceipt<A>["operation"],
    response: DesktopResponseEnvelope,
    decode: (value: unknown) => A,
  ): DesktopRequestReceipt<A> {
    if (
      response.resultType != null &&
      response.resultType !== "success" &&
      response.resultType !== "error"
    ) {
      throw new DesktopProtocolError(
        "response-malformed",
        "operation",
        "written",
        "Desktop IPC response has an unknown result type",
      );
    }
    return {
      fingerprint: connection.profile.fingerprint,
      operation,
      requestId: response.requestId,
      outcome: response.resultType === "error"
        ? {
            _tag: "Rejected",
            rejection: normalizeDesktopRejection(response.error),
          }
        : { _tag: "Accepted", value: decode(response.result) },
    };
  }

  private async ready(
    capability: DesktopProtocolCapability,
  ): Promise<NegotiatedConnection> {
    const connection = await this.ensureConnection();
    if (!connection.profile.capabilities[capability]) {
      throw new DesktopProtocolError(
        "unsupported-capability",
        "operation",
        "not-written",
        `Desktop IPC does not advertise ${capability}`,
      );
    }
    return connection;
  }

  private async ensureConnection(): Promise<NegotiatedConnection> {
    if (this.closing) {
      throw this.closedError();
    }
    const active = this.connection;
    if (active?.raw.alive === true) {
      const currentIdentity = await desktopEndpointIdentity(this.socketPath);
      if (
        currentIdentity == null ||
        active.raw.endpointIdentity == null ||
        currentIdentity === active.raw.endpointIdentity
      ) return active;
      active.raw.close();
    }
    if (this.reconnecting == null) {
      this.reconnecting = this.open(true).finally(() => {
        this.reconnecting = null;
      });
    }
    const connection = await this.reconnecting;
    if (this.closing) {
      connection.raw.close();
      throw this.closedError();
    }
    if (this.connection !== connection) {
      this.connection = connection;
      this.emit({ _tag: "Reconnected", profile: connection.profile });
    }
    return this.connection;
  }

  private async open(reconnected: boolean): Promise<NegotiatedConnection> {
    const raw = await RawDesktopConnection.open(
      this.socketPath,
      this.limits,
      (message) => this.receiveBroadcast(message),
      (observation) => this.emit(observation),
    );
    try {
      const response = await raw.request(
        "initialize",
        DESKTOP_INITIALIZE_PARAMS,
        0,
        this.limits.handshakeTimeoutMs,
      );
      if (response.resultType === "error") {
        throw new DesktopProtocolError(
          "handshake-malformed",
          "handshake",
          "not-written",
          "Desktop IPC initialize request was rejected",
        );
      }
      if (
        response.resultType != null && response.resultType !== "success"
      ) {
        throw new DesktopProtocolError(
          "handshake-malformed",
          "handshake",
          "not-written",
          "Desktop IPC initialize response has an unknown result type",
        );
      }
      const handshake = decodeDesktopHandshake(response.result);
      raw.setInitializedClientId(handshake.clientId);
      const adapter = selectDesktopAdapter(handshake);
      const profile = {
        capabilities: handshake.capabilities,
        fingerprint: fingerprintDesktopProtocol(handshake, adapter),
      };
      if (reconnected) {
        this.emit({ _tag: "Reconnecting", profile });
        if (
          this.followedThreads.size > 0 &&
          !profile.capabilities.threadStream
        ) {
          throw new DesktopProtocolError(
            "reconnect-failed",
            "operation",
            "not-written",
            "Desktop IPC reconnect cannot restore followed tasks",
          );
        }
        try {
          for (const threadId of this.followedThreads) {
            await raw.broadcast(
              adapter.methods.follow,
              adapter.followParams(threadId),
              adapter.version,
            );
          }
        } catch {
          throw new DesktopProtocolError(
            "reconnect-failed",
            "operation",
            "not-written",
            "Desktop IPC reconnect could not restore followed tasks",
          );
        }
      }
      return { adapter, profile, raw };
    } catch (cause) {
      raw.close();
      throw cause;
    }
  }

  private receiveBroadcast(message: DesktopWireEnvelope): void {
    if (typeof message.method !== "string") {
      this.emit({ _tag: "MalformedBroadcast" });
      return;
    }
    for (const listener of this.broadcasts) listener(message);
  }

  private closedError(): DesktopProtocolError {
    return new DesktopProtocolError(
      "closed",
      "operation",
      "not-written",
      "Desktop IPC session is closed",
    );
  }

  private emit(observation: DesktopProtocolObservation): void {
    for (const listener of this.observations) listener(observation);
  }
}
