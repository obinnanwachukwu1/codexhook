import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import net from "node:net";
import {
  DesktopProtocolError,
  isAbsentDesktopEndpointError,
  safeSocketError,
} from "./errors.js";
import {
  DesktopFrameDecoder,
  encodeDesktopFrame,
} from "./framing.js";
import type {
  DesktopProtocolObservation,
  DesktopWireEnvelope,
} from "./types.js";

export interface DesktopWireLimits {
  readonly maxFrameBytes: number;
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

interface PendingRequest {
  readonly method: string;
  readonly reject: (error: DesktopProtocolError) => void;
  readonly resolve: (message: DesktopWireEnvelope) => void;
  readonly timeout: NodeJS.Timeout;
  written: boolean;
}

export async function desktopEndpointIdentity(
  socketPath: string,
): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const info = await lstat(socketPath);
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

function disconnectedError(
  pending: PendingRequest,
  failure: "closed" | "frame-invalid" | "write-failed",
  message: string,
  cause?: unknown,
): DesktopProtocolError {
  return new DesktopProtocolError(
    failure,
    failure === "frame-invalid" ? "framing" : "operation",
    pending.written ? "unknown" : "not-written",
    message,
    undefined,
    cause == null ? undefined : { cause },
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
    this.decoder = new DesktopFrameDecoder(limits.maxFrameBytes);
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => this.end("closed"));
    socket.on("error", (cause) => this.end("socket-error", cause));
  }

  static async open(
    socketPath: string,
    limits: DesktopWireLimits,
    onBroadcast: DesktopBroadcastListener,
    onObservation: DesktopObservationListener,
  ): Promise<RawDesktopConnection> {
    const socket = net.createConnection(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        const connected = () => {
          socket.off("error", rejected);
          resolve();
        };
        const rejected = (cause: Error) => {
          socket.off("connect", connected);
          reject(cause);
        };
        socket.once("connect", connected);
        socket.once("error", rejected);
      });
    } catch (cause) {
      socket.destroy();
      throw new DesktopProtocolError(
        isAbsentDesktopEndpointError(cause)
          ? "socket-unavailable"
          : "socket-failed",
        "connect",
        "not-written",
        safeSocketError(cause),
        undefined,
        { cause },
      );
    }
    return new RawDesktopConnection(
      socket,
      await desktopEndpointIdentity(socketPath),
      limits,
      onBroadcast,
      onObservation,
    );
  }

  get alive(): boolean {
    return !this.ended && !this.socket.destroyed && this.socket.writable;
  }

  setInitializedClientId(clientId: string): void {
    this.clientId = clientId;
  }

  close(): void {
    this.ended = true;
    this.socket.destroy();
    this.rejectAll("closed", "Desktop IPC connection closed");
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
    }, this.limits.maxFrameBytes);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, (cause) => {
        if (cause == null) resolve();
        else {
          reject(new DesktopProtocolError(
            "write-failed",
            "operation",
            "unknown",
            "Desktop IPC broadcast write failed",
            undefined,
            { cause },
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
  ): Promise<DesktopWireEnvelope> {
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
          requestId,
        ));
      }, timeoutMs);
      const pending: PendingRequest = {
        method,
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
        }, this.limits.maxFrameBytes);
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
            cause,
          ));
        });
        // Crossing socket.write is the submission barrier. Any later failure is
        // ambiguous and must never cause the protocol layer to replay the call.
        pending.written = true;
      } catch (cause) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(disconnectedError(
          pending,
          "write-failed",
          "Desktop IPC request write failed",
          cause,
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
        "request-timeout",
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
    } catch (cause) {
      this.end("protocol-error", cause);
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
      this.onObservation({
        _tag: "OrphanResponse",
        requestId: message.requestId,
      });
      return;
    }
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.method != null && message.method !== pending.method) {
      pending.reject(new DesktopProtocolError(
        "response-malformed",
        "operation",
        "written",
        "Desktop IPC response method did not match its request",
        message.requestId,
      ));
      return;
    }
    pending.resolve(message);
  }

  private writeDiscoveryResponse(requestId: string | undefined): void {
    if (requestId == null || !this.alive) return;
    try {
      this.socket.write(encodeDesktopFrame({
        type: "client-discovery-response",
        requestId,
        response: { canHandle: false },
      }, this.limits.maxFrameBytes));
    } catch {
      this.socket.destroy();
    }
  }

  private end(
    reason: "closed" | "socket-error" | "protocol-error",
    cause?: unknown,
  ): void {
    if (this.ended) return;
    this.ended = true;
    this.rejectAll(
      reason === "protocol-error" ? "frame-invalid" : "closed",
      reason === "protocol-error"
        ? "Desktop IPC protocol framing failed"
        : "Desktop IPC connection closed",
      cause,
    );
    this.onObservation({ _tag: "Disconnected", reason });
  }

  private rejectAll(
    failure: "closed" | "frame-invalid",
    message: string,
    cause?: unknown,
  ): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(disconnectedError(pending, failure, message, cause));
    }
    this.pending.clear();
  }
}
