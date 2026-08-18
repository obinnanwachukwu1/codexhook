export type DesktopProtocolFailure =
  | "closed"
  | "connect-timeout"
  | "frame-invalid"
  | "handshake-malformed"
  | "invalid-timeout"
  | "pending-limit"
  | "reconnect-failed"
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
  ) {
    super(message);
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
