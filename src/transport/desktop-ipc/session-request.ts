import { DesktopProtocolError } from "./errors.js";
import type { SessionLimits } from "./limits.js";
import { DesktopThreadOwners } from "./thread-owners.js";
import type { DesktopRequestReceipt } from "./types.js";

const ROUTING_REJECTIONS = new Set([
  "client-cannot-handle-request",
  "client-not-found",
  "no-client-found",
  "thread-stream-owner-unavailable",
]);

export function dropRejectedOwner(
  owners: DesktopThreadOwners,
  threadId: string,
  receipt: DesktopRequestReceipt<unknown>,
): void {
  if (
    receipt.outcome._tag === "Rejected" &&
    ROUTING_REJECTIONS.has(receipt.outcome.rejection)
  ) owners.drop(threadId);
}

export function requestDeadline(
  limits: SessionLimits,
  timeoutMs: number,
): number {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < limits.minRequestTimeoutMs
  ) {
    throw new DesktopProtocolError(
      "invalid-timeout",
      "operation",
      "not-written",
      "Desktop IPC request timeout is outside bounds",
    );
  }
  return Date.now() + Math.min(timeoutMs, limits.maxRequestTimeoutMs);
}

export function remainingRequestTimeout(
  limits: SessionLimits,
  deadline: number,
): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < limits.minRequestTimeoutMs) {
    throw new DesktopProtocolError(
      "request-timeout",
      "operation",
      "not-written",
      "Desktop IPC request budget expired before submission",
    );
  }
  return remaining;
}

export async function requestTarget(
  owners: DesktopThreadOwners,
  followedThreads: ReadonlySet<string>,
  limits: SessionLimits,
  threadId: string,
  deadline: number,
  requireFollow: boolean,
): Promise<string | undefined> {
  if (!followedThreads.has(threadId)) {
    if (!requireFollow) return undefined;
    throw new DesktopProtocolError(
      "task-not-followed",
      "operation",
      "not-written",
      "Desktop IPC task must be followed before mutation",
    );
  }
  const owner = await owners.wait(
    threadId,
    remainingRequestTimeout(limits, deadline),
  );
  if (owner != null) return owner;
  throw new DesktopProtocolError(
    "request-timeout",
    "operation",
    "not-written",
    "Desktop IPC task owner was not observed before submission",
  );
}
