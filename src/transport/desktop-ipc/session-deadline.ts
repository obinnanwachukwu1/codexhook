import { DesktopProtocolError } from "./errors.js";
import type { SessionLimits } from "./limits.js";
import type { NegotiatedConnection } from "./session-negotiate.js";
import { remainingRequestTimeout } from "./session-request.js";

export function reconnectStageTimeout(
  limits: SessionLimits,
  deadline?: number,
): number {
  return deadline == null
    ? limits.handshakeTimeoutMs
    : Math.min(
      limits.handshakeTimeoutMs,
      remainingRequestTimeout(limits, deadline),
    );
}

export async function waitForReconnect(
  limits: SessionLimits,
  reconnecting: Promise<NegotiatedConnection>,
  deadline?: number,
): Promise<NegotiatedConnection> {
  if (deadline == null) return reconnecting;
  const timeoutMs = remainingRequestTimeout(limits, deadline);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DesktopProtocolError(
      "request-timeout",
      "operation",
      "not-written",
      "Desktop IPC reconnect exceeded the request deadline",
    )), timeoutMs);
  });
  try {
    return await Promise.race([reconnecting, timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
