import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  DesktopProtocolError,
  isAbsentDesktopEndpointError,
  safeSocketError,
} from "./errors.js";
import { DesktopFrameDecoder, encodeDesktopFrame } from "./framing.js";
import { desktopEndpointIdentity } from "./endpoint-identity.js";
import type {
  DesktopProtocolObservation,
  DesktopResponseEnvelope,
  DesktopWireEnvelope,
} from "./types.js";
export interface DesktopWireLimits {
  readonly maxInboundFrameBytes: number;
  readonly maxOutboundFrameBytes: number;
  readonly maxPendingRequests: number;
  readonly maxRequestTimeoutMs: number;
  readonly minRequestTimeoutMs: number;
}

export type DesktopBroadcastListener = (
  message: DesktopWireEnvelope,
) => void;
export type DesktopObservationListener = (
  observation: DesktopProtocolObservation,
) => void;

export interface DesktopOpenOptions {
  readonly connectTimeoutMs: number;
  readonly createConnection?: () => net.Socket;
  readonly onOpeningSocket: (socket: net.Socket | null) => void;
}

interface PendingRequest {
  readonly reject: (error: DesktopProtocolError) => void;
  readonly resolve: (message: DesktopResponseEnvelope) => void;
  readonly timeout: NodeJS.Timeout;
  written: boolean;
}

function disconnectedError(
  pending: PendingRequest,
  failure: "closed" | "frame-invalid" | "write-failed",
  message: string,
): DesktopProtocolError {
  return new DesktopProtocolError(
    failure,
    failure === "frame-invalid" ? "framing" : "operation",
    pending.written ? "unknown" : "not-written",
    message,
  );
}

export class RawDesktopConnection {
  private clientId = "initializing-client";
  private readonly decoder: DesktopFrameDecoder;
  private ended = false;
  private readonly pending = new Map<string, PendingRequest>();

  private constructor(
    private readonly socket: net.Socket,
    readonly endpointIdentity: string | null,
    private readonly limits: DesktopWireLimits,
    private readonly onBroadcast: DesktopBroadcastListener,
    private readonly onObservation: DesktopObservationListener,
  ) {
    this.decoder = new DesktopFrameDecoder(
      limits.maxInboundFrameBytes,
      () => this.onObservation({ _tag: "MalformedEnvelope" }),
    );
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => this.end("closed"));
    socket.on("error", () => this.end("socket-error"));
  }

  static async open(
    socketPath: string,
    limits: DesktopWireLimits,
    onBroadcast: DesktopBroadcastListener,
    onObservation: DesktopObservationListener,
    options: DesktopOpenOptions,
  ): Promise<RawDesktopConnection> {
    const endpointIdentity = desktopEndpointIdentity(socketPath);
    let socket: net.Socket;
    try {
      socket = options.createConnection?.() ?? net.createConnection(socketPath);
    } catch (cause) {
      throw new DesktopProtocolError(
        isAbsentDesktopEndpointError(cause)
          ? "socket-unavailable"
          : "socket-failed",
        "connect",
        "not-written",
        safeSocketError(cause),
      );
    }
    try {
      const identity = await new Promise<string | null>((resolve, reject) => {
        let settled = false;
        let connectedToEndpoint = false;
        let identityKnown = false;
        let identity: string | null = null;
        const finish = (effect: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          socket.off("close", closed);
          socket.off("connect", connected);
          socket.off("error", rejected);
          effect();
        };
        const complete = () => {
          if (connectedToEndpoint && identityKnown) {
            finish(() => resolve(identity));
          }
        };
        const connected = () => {
          connectedToEndpoint = true;
          complete();
        };
        const rejected = (cause: Error) => {
          finish(() => reject(cause));
        };
        const closed = () => finish(() => reject(new DesktopProtocolError(
          "closed",
          "connect",
          "not-written",
          "Desktop IPC connection closed during connect",
        )));
        const timeout = setTimeout(() => finish(() => reject(
          new DesktopProtocolError(
            "connect-timeout",
            "connect",
            "not-written",
            "Desktop IPC connect timed out",
          ),
        )), options.connectTimeoutMs);
        socket.once("close", closed);
        socket.once("connect", connected);
        socket.once("error", rejected);
        endpointIdentity.then((value) => {
          identity = value;
          identityKnown = true;
          complete();
        });
        options.onOpeningSocket(socket);
        if (socket.destroyed) closed();
      });
      return new RawDesktopConnection(
        socket,
        identity,
        limits,
        onBroadcast,
        onObservation,
      );
    } catch (cause) {
      socket.once("error", () => undefined);
      socket.destroy();
      if (cause instanceof DesktopProtocolError) throw cause;
      throw new DesktopProtocolError(
        isAbsentDesktopEndpointError(cause)
          ? "socket-unavailable"
          : "socket-failed",
        "connect",
        "not-written",
        safeSocketError(cause),
      );
    } finally {
      options.onOpeningSocket(null);
    }
  }

  get alive(): boolean {
    return !this.ended && !this.socket.destroyed && this.socket.writable;
  }

  setInitializedClientId(clientId: string): void {
    this.clientId = clientId;
  }

  close(): void {
    this.socket.destroy();
    if (this.ended) return;
    this.ended = true;
    this.rejectAll("closed", "Desktop IPC connection closed");
    this.onObservation({ _tag: "Disconnected", reason: "closed" });
  }

  async broadcast(
    method: string,
    params: unknown,
    version: number,
  ): Promise<void> {
    if (!this.alive) {
      throw new DesktopProtocolError(
        "closed",
        "operation",
        "not-written",
        "Desktop IPC connection is closed",
      );
    }
    const frame = encodeDesktopFrame({
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      params,
      version,
    }, this.limits.maxOutboundFrameBytes);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, (cause) => {
        if (cause == null) resolve();
        else {
          reject(new DesktopProtocolError(
            "write-failed",
            "operation",
            "unknown",
            "Desktop IPC broadcast write failed",
          ));
        }
      });
    });
  }

  request(
    method: string,
    params: unknown,
    version: number,
    timeoutMs: number,
    targetClientId?: string,
  ): Promise<DesktopResponseEnvelope> {
    const invalid = this.validateRequest(timeoutMs);
    if (invalid != null) return Promise.reject(invalid);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending == null) return;
        this.pending.delete(requestId);
        reject(new DesktopProtocolError(
          "request-timeout",
          "operation",
          pending.written ? "unknown" : "not-written",
          `Desktop IPC ${method} request timed out`,
        ));
      }, timeoutMs);
      const pending: PendingRequest = {
        reject,
        resolve,
        timeout,
        written: false,
      };
      this.pending.set(requestId, pending);
      let frame: Buffer;
      try {
        frame = encodeDesktopFrame({
          type: "request",
          requestId,
          sourceClientId: this.clientId,
          version,
          method,
          params,
          timeoutMs,
          ...(targetClientId == null ? {} : { targetClientId }),
        }, this.limits.maxOutboundFrameBytes);
      } catch (cause) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(cause as DesktopProtocolError);
        return;
      }
      try {
        this.socket.write(frame, (cause) => {
          if (cause == null) return;
          const active = this.pending.get(requestId);
          if (active == null) return;
          clearTimeout(active.timeout);
          this.pending.delete(requestId);
          active.reject(disconnectedError(
            active,
            "write-failed",
            "Desktop IPC request write failed",
          ));
        });
        // Crossing socket.write is the submission barrier. Any later failure is
        // ambiguous and must never cause the protocol layer to replay the call.
        pending.written = true;
      } catch {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(disconnectedError(
          pending,
          "write-failed",
          "Desktop IPC request write failed",
        ));
      }
    });
  }

  private validateRequest(timeoutMs: number): DesktopProtocolError | null {
    if (!this.alive) {
      return new DesktopProtocolError(
        "closed",
        "operation",
        "not-written",
        "Desktop IPC connection is closed",
      );
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < this.limits.minRequestTimeoutMs ||
      timeoutMs > this.limits.maxRequestTimeoutMs
    ) {
      return new DesktopProtocolError(
        "invalid-timeout",
        "operation",
        "not-written",
        "Desktop IPC request timeout is outside bounds",
      );
    }
    return this.pending.size >= this.limits.maxPendingRequests
      ? new DesktopProtocolError(
          "pending-limit",
          "operation",
          "not-written",
          "Desktop IPC pending request limit reached",
        )
      : null;
  }

  private receive(chunk: Buffer): void {
    let messages: ReadonlyArray<DesktopWireEnvelope>;
    try {
      messages = this.decoder.push(chunk);
    } catch {
      this.end("protocol-error");
      this.socket.destroy();
      return;
    }
    for (const message of messages) this.handle(message);
  }

  private handle(message: DesktopWireEnvelope): void {
    if (message.type === "client-discovery-request") {
      this.writeDiscoveryResponse(message.requestId);
      return;
    }
    if (message.type === "broadcast") {
      this.onBroadcast(message);
      return;
    }
    if (message.type !== "response" || message.requestId == null) return;
    const pending = this.pending.get(message.requestId);
    if (pending == null) {
      this.onObservation({ _tag: "OrphanResponse" });
      return;
    }
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(message as DesktopResponseEnvelope);
  }

  private writeDiscoveryResponse(requestId: string | undefined): void {
    if (requestId == null || !this.alive) return;
    try {
      this.socket.write(encodeDesktopFrame({
        type: "client-discovery-response",
        requestId,
        response: { canHandle: false },
      }, this.limits.maxOutboundFrameBytes));
    } catch {
      this.socket.destroy();
    }
  }

  private end(reason: "closed" | "socket-error" | "protocol-error"): void {
    if (this.ended) return;
    this.ended = true;
    this.rejectAll(
      reason === "protocol-error" ? "frame-invalid" : "closed",
      reason === "protocol-error"
        ? "Desktop IPC protocol framing failed"
        : "Desktop IPC connection closed",
    );
    this.onObservation({ _tag: "Disconnected", reason });
  }

  private rejectAll(
    failure: "closed" | "frame-invalid",
    message: string,
  ): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(disconnectedError(pending, failure, message));
    }
    this.pending.clear();
  }
}
