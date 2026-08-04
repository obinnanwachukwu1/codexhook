import { randomUUID } from "node:crypto";
import net from "node:net";

const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export interface IpcEnvelope {
  readonly type: string;
  readonly method?: string;
  readonly requestId?: string;
  readonly resultType?: "success" | "error";
  readonly result?: unknown;
  readonly error?: string;
  readonly params?: unknown;
  readonly version?: number;
}

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (message: IpcEnvelope) => void;
  readonly timeout: NodeJS.Timeout;
}

export type DesktopIpcConnectFailure =
  | "socket-unavailable"
  | "socket-failed"
  | "initialize-timeout"
  | "initialize-malformed"
  | "initialize-failed";

export class DesktopIpcConnectError extends Error {
  override readonly name = "DesktopIpcConnectError";

  constructor(
    readonly failure: DesktopIpcConnectFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isAbsentDesktopEndpointError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export class DesktopIpcClient {
  private buffer = Buffer.alloc(0);
  private clientId = "initializing-client";
  private readonly broadcasts = new Set<(message: IpcEnvelope) => void>();
  private readonly pending = new Map<string, Pending>();

  private constructor(
    private readonly socket: net.Socket,
  ) {
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => this.rejectAll(new Error("Desktop IPC closed")));
    socket.on("error", (error) => this.rejectAll(error));
  }

  static async connect(socketPath: string): Promise<DesktopIpcClient> {
    const socket = net.connect(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    } catch (cause) {
      socket.destroy();
      throw new DesktopIpcConnectError(
        isAbsentDesktopEndpointError(cause)
          ? "socket-unavailable"
          : "socket-failed",
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      );
    }
    const client = new DesktopIpcClient(socket);
    try {
      const initialized = await client.request(
        "initialize",
        { clientType: "codexhook" },
        0,
        5_000,
      );
      const result = initialized.result as
        | { readonly clientId?: unknown }
        | undefined;
      if (typeof result?.clientId !== "string") {
        throw new DesktopIpcConnectError(
          "initialize-malformed",
          "Desktop IPC initialize response was malformed",
        );
      }
      client.clientId = result.clientId;
      return client;
    } catch (cause) {
      client.close();
      if (cause instanceof DesktopIpcConnectError) throw cause;
      const message =
        cause instanceof Error ? cause.message : String(cause);
      throw new DesktopIpcConnectError(
        message.includes("timed out")
          ? "initialize-timeout"
          : "initialize-failed",
        message,
        { cause },
      );
    }
  }

  get alive(): boolean {
    return !this.socket.destroyed && this.socket.writable;
  }

  close(): void {
    this.socket.destroy();
  }

  onBroadcast(listener: (message: IpcEnvelope) => void): () => void {
    this.broadcasts.add(listener);
    return () => this.broadcasts.delete(listener);
  }

  broadcast(method: string, params: unknown, version: number): void {
    this.write({
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      params,
      version,
    });
  }

  request(
    method: string,
    params: unknown,
    version: number,
    timeoutMs: number,
  ): Promise<IpcEnvelope> {
    if (!this.alive) return Promise.reject(new Error("Desktop IPC is closed"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { reject, resolve, timeout });
      try {
        this.write({
          type: "request",
          requestId,
          sourceClientId: this.clientId,
          version,
          method,
          params,
          timeoutMs,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private write(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.socket.write(frame);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.socket.destroy(new Error("Invalid Desktop IPC frame length"));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message: IpcEnvelope;
      try {
        message = JSON.parse(body.toString("utf8")) as IpcEnvelope;
      } catch {
        this.socket.destroy(new Error("Invalid Desktop IPC JSON"));
        return;
      }
      this.handle(message);
    }
  }

  private handle(message: IpcEnvelope): void {
    if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (message.type === "broadcast") {
      for (const listener of this.broadcasts) listener(message);
      return;
    }
    if (message.type !== "response" || message.requestId == null) return;
    const pending = this.pending.get(message.requestId);
    if (pending == null) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
