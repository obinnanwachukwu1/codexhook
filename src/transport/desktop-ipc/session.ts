import {
  desktopReconnectError,
  DesktopProtocolError,
} from "./errors.js";
import { desktopEndpointIdentity } from "./endpoint-identity.js";
import { sessionLimits, type SessionLimits } from "./limits.js";
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
  RawDesktopConnection,
  type DesktopBroadcastListener,
  type DesktopObservationListener,
} from "./wire.js";
import { desktopRequestReceipt } from "./session-receipt.js";
import { followDesktopThread } from "./session-follow.js";
import {
  negotiateDesktopConnection,
  type NegotiatedConnection,
} from "./session-negotiate.js";
import {
  dropRejectedOwner,
  remainingRequestTimeout,
  requestDeadline,
  requestTarget,
} from "./session-request.js";
import { DesktopThreadOwners } from "./thread-owners.js";
import type { Socket } from "node:net";

export class DesktopProtocolSession {
  private readonly broadcasts = new Set<DesktopBroadcastListener>();
  private closing = false;
  private connection: NegotiatedConnection | null = null;
  private readonly followedThreads = new Set<string>();
  private readonly limits: SessionLimits;
  private readonly observations = new Set<DesktopObservationListener>();
  private readonly threadOwners = new DesktopThreadOwners();
  private openingRaw: RawDesktopConnection | null = null;
  private openingSocket: Socket | null = null;
  private reconnecting: Promise<NegotiatedConnection> | null = null;
  private readonly createConnection: (() => Socket) | undefined;

  private constructor(
    private readonly socketPath: string,
    options: DesktopProtocolSessionOptions,
  ) {
    this.limits = sessionLimits(options);
    this.createConnection = options.createConnection;
  }

  static async connect(
    socketPath: string,
    options: DesktopProtocolSessionOptions = {},
    signal?: AbortSignal,
    onCreate?: (session: DesktopProtocolSession) => void,
  ): Promise<DesktopProtocolSession> {
    const session = new DesktopProtocolSession(socketPath, options);
    onCreate?.(session);
    const abort = () => session.close();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (session.closing) throw session.closedError();
      session.connection = await session.open(false);
      if (signal?.aborted) {
        session.close();
        throw session.closedError();
      }
      return session;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
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

  requestTimeout(timeoutMs: number): number {
    return Math.min(timeoutMs, this.limits.maxRequestTimeoutMs);
  }

  close(): void {
    this.closing = true;
    this.threadOwners.reset();
    this.connection?.raw.close();
    this.openingSocket?.destroy();
    this.openingRaw?.close();
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
    await followDesktopThread(
      connection,
      this.followedThreads,
      this.threadOwners,
      threadId,
    );
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
    const deadline = requestDeadline(this.limits, timeoutMs);
    const connection = await this.ready("completeHistory");
    const target = await requestTarget(
      this.threadOwners,
      this.followedThreads,
      this.limits,
      threadId,
      deadline,
    );
    const response = await connection.raw.request(
      connection.adapter.methods.history,
      connection.adapter.historyParams(threadId),
      connection.adapter.version,
      remainingRequestTimeout(this.limits, deadline),
      target,
    );
    const receipt = desktopRequestReceipt(
      connection.profile,
      "load-history",
      response,
      () => undefined,
    );
    dropRejectedOwner(this.threadOwners, threadId, receipt);
    return receipt;
  }

  async startTurn(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<DesktopStartResult>> {
    const deadline = requestDeadline(this.limits, timeoutMs);
    const connection = await this.ready("startTurn");
    const target = await requestTarget(
      this.threadOwners,
      this.followedThreads,
      this.limits,
      threadId,
      deadline,
    );
    const response = await connection.raw.request(
      connection.adapter.methods.start,
      connection.adapter.startParams(threadId, params),
      connection.adapter.version,
      remainingRequestTimeout(this.limits, deadline),
      target,
    );
    const receipt = desktopRequestReceipt(
      connection.profile,
      "start-turn",
      response,
      (value) => connection.adapter.decodeStart(value),
    );
    dropRejectedOwner(this.threadOwners, threadId, receipt);
    return receipt;
  }

  async steerTurn(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DesktopRequestReceipt<DesktopSteerResult>> {
    const deadline = requestDeadline(this.limits, timeoutMs);
    const connection = await this.ready("steerTurn");
    const target = await requestTarget(
      this.threadOwners,
      this.followedThreads,
      this.limits,
      threadId,
      deadline,
    );
    const response = await connection.raw.request(
      connection.adapter.methods.steer,
      connection.adapter.steerParams(threadId, params),
      connection.adapter.version,
      remainingRequestTimeout(this.limits, deadline),
      target,
    );
    const receipt = desktopRequestReceipt(
      connection.profile,
      "steer-turn",
      response,
      (value) => connection.adapter.decodeSteer(value),
    );
    dropRejectedOwner(this.threadOwners, threadId, receipt);
    return receipt;
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
    if (this.closing) throw this.closedError();
    const raw = await RawDesktopConnection.open(
      this.socketPath,
      this.limits,
      (message) => this.receiveBroadcast(message),
      (observation) => this.emit(observation),
      {
        connectTimeoutMs: this.limits.handshakeTimeoutMs,
        ...(this.createConnection == null
          ? {}
          : { createConnection: this.createConnection }),
        onOpeningSocket: (socket) => {
          this.openingSocket = socket;
          if (socket != null && this.closing) socket.destroy();
        },
      },
    );
    this.openingRaw = raw;
    if (this.closing) {
      raw.close();
      throw this.closedError();
    }
    try {
      return await negotiateDesktopConnection(
        raw,
        this.limits.handshakeTimeoutMs,
        reconnected,
        this.followedThreads,
        (observation) => this.emit(observation),
        () => {
          if (this.closing) throw this.closedError();
        },
      );
    } catch (cause) {
      raw.close();
      if (reconnected) {
        if (this.closing) throw this.closedError();
        if (
          !(cause instanceof DesktopProtocolError) ||
          cause.writeState !== "not-written"
        ) {
          throw desktopReconnectError("Desktop IPC reconnect handshake failed");
        }
      }
      throw cause;
    } finally {
      if (this.openingRaw === raw) this.openingRaw = null;
    }
  }

  private receiveBroadcast(message: DesktopWireEnvelope): void {
    if (typeof message.method !== "string") {
      this.emit({ _tag: "MalformedBroadcast" });
      return;
    }
    this.threadOwners.observe(message, this.followedThreads);
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
    if (
      observation._tag === "Disconnected" ||
      observation._tag === "Reconnecting"
    ) {
      this.threadOwners.reset();
    }
    for (const listener of this.observations) listener(observation);
  }
}
