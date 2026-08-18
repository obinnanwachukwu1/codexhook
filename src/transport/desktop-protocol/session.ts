import {
  decodeDesktopBroadcast,
  decodeDesktopHandshake,
  DESKTOP_INITIALIZE_PARAMS,
  fingerprintDesktopProtocol,
  normalizeDesktopRejection,
  selectDesktopAdapter,
  type DesktopProtocolAdapter,
} from "./adapters.js";
import { DesktopProtocolError } from "./errors.js";
import { DEFAULT_MAX_FRAME_BYTES } from "./framing.js";
import type {
  DesktopProtocolCapability,
  DesktopProtocolObservation,
  DesktopProtocolProfile,
  DesktopProtocolSessionOptions,
  DesktopRequestReceipt,
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
    maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
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
    return this.connection?.raw.alive === true;
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
      "thread-stream-following-changed",
      connection.adapter.followParams(threadId),
      connection.adapter.versions.follow,
    );
    return {
      adapterId: connection.adapter.id,
      fingerprint: connection.profile.fingerprint,
      operation: "follow-thread",
      writeState: "written",
    };
  }

  loadCompleteHistory(
    threadId: string,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<unknown>> {
    return this.request(
      "completeHistory",
      "load-history",
      "thread-follower-load-complete-history",
      (adapter) => adapter.historyParams(threadId),
      (adapter) => adapter.versions.history,
      timeoutMs,
      (value) => value,
    );
  }

  startTurn(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<DesktopStartResult>> {
    return this.request(
      "startTurn",
      "start-turn",
      "thread-follower-start-turn",
      (adapter) => adapter.startParams(threadId, params),
      (adapter) => adapter.versions.start,
      timeoutMs,
      (value, adapter) => adapter.decodeStart(value),
    );
  }

  steerTurn(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<DesktopSteerResult>> {
    return this.request(
      "steerTurn",
      "steer-turn",
      "thread-follower-steer-turn",
      (adapter) => adapter.steerParams(threadId, params),
      (adapter) => adapter.versions.steer,
      timeoutMs,
      (value, adapter) => adapter.decodeSteer(value),
    );
  }

  private async request<A>(
    capability: DesktopProtocolCapability,
    operation: DesktopRequestReceipt<A>["operation"],
    method: string,
    params: (adapter: DesktopProtocolAdapter) => unknown,
    version: (adapter: DesktopProtocolAdapter) => number,
    timeoutMs: number,
    decode: (value: unknown, adapter: DesktopProtocolAdapter) => A,
  ): Promise<DesktopRequestReceipt<A>> {
    const connection = await this.ready(capability);
    const response = await connection.raw.request(
      method,
      params(connection.adapter),
      version(connection.adapter),
      timeoutMs,
    );
    if (response.requestId == null || response.resultType == null) {
      throw new DesktopProtocolError(
        "response-malformed",
        "operation",
        "written",
        `Desktop IPC ${operation} response is malformed`,
      );
    }
    return {
      adapterId: connection.adapter.id,
      fingerprint: connection.profile.fingerprint,
      operation,
      requestId: response.requestId,
      outcome: response.resultType === "error"
        ? {
            _tag: "Rejected",
            rejection: normalizeDesktopRejection(response.error),
          }
        : { _tag: "Accepted", value: decode(response.result, connection.adapter) },
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
      throw new DesktopProtocolError(
        "closed",
        "operation",
        "not-written",
        "Desktop IPC session is closed",
      );
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
    this.connection = await this.reconnecting;
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
      if (response.resultType !== "success") {
        throw new DesktopProtocolError(
          "handshake-malformed",
          "handshake",
          "not-written",
          "Desktop IPC initialize request was rejected",
        );
      }
      const handshake = decodeDesktopHandshake(response.result);
      raw.setInitializedClientId(handshake.clientId);
      const adapter = selectDesktopAdapter(handshake);
      const profile = {
        capabilities: handshake.capabilities,
        fingerprint: fingerprintDesktopProtocol(handshake, adapter),
      };
      this.emit({
        _tag: reconnected ? "Reconnected" : "Connected",
        profile,
      });
      return { adapter, profile, raw };
    } catch (cause) {
      raw.close();
      throw cause;
    }
  }

  private receiveBroadcast(message: DesktopWireEnvelope): void {
    const broadcast = decodeDesktopBroadcast(message);
    if (broadcast == null) {
      this.emit({ _tag: "MalformedBroadcast" });
      return;
    }
    for (const listener of this.broadcasts) listener(broadcast);
  }

  private emit(observation: DesktopProtocolObservation): void {
    for (const listener of this.observations) listener(observation);
  }
}
