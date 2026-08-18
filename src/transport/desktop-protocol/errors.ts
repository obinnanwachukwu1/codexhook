export type DesktopProtocolFailure =
  | "closed"
  | "frame-invalid"
  | "handshake-malformed"
  | "pending-limit"
  | "request-timeout"
  | "response-malformed"
  | "socket-failed"
  | "socket-unavailable"
  | "unknown-protocol-version"
  | "unsupported-capability"
  | "write-failed";

export type DesktopWriteState = "not-written" | "unknown" | "written";

export class DesktopProtocolError extends Error {
  override readonly name = "DesktopProtocolError";

  constructor(
    readonly failure: DesktopProtocolFailure,
    readonly stage: "connect" | "framing" | "handshake" | "operation",
    readonly writeState: DesktopWriteState,
    message: string,
    readonly requestId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isAbsentDesktopEndpointError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export function safeSocketError(cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string"
    ? `Desktop IPC socket error (${code})`
    : "Desktop IPC socket error";
}
