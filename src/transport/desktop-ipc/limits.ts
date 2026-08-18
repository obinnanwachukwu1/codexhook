import { DesktopProtocolError } from "./errors.js";
import {
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
} from "./framing.js";
import type { DesktopProtocolSessionOptions } from "./types.js";
import type { DesktopWireLimits } from "./wire.js";

const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MIN_REQUEST_TIMEOUT_MS = 10;

export interface SessionLimits extends DesktopWireLimits {
  readonly handshakeTimeoutMs: number;
}

export function sessionLimits(
  options: DesktopProtocolSessionOptions,
): SessionLimits {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs < 1 ||
    handshakeTimeoutMs > DEFAULT_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new DesktopProtocolError(
      "invalid-timeout",
      "connect",
      "not-written",
      "Desktop IPC handshake timeout is outside bounds",
    );
  }
  return {
    handshakeTimeoutMs,
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
