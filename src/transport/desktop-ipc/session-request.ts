import { DesktopProtocolError } from "./errors.js";
import type { SessionLimits } from "./limits.js";
import { DesktopThreadOwners } from "./thread-owners.js";
import type { DesktopRequestReceipt } from "./types.js";

const OWNER_EVIDENCE_TIMEOUT_MS = 1_000;
export const MAX_MUTATION_TIMEOUT_MS = 30_000;

export function dropRejectedOwner(
  owners: DesktopThreadOwners,
  threadId: string,
  receipt: DesktopRequestReceipt<unknown>,
): void {
  if (receipt.outcome._tag === "Rejected") owners.invalidate(threadId);
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

export function mutationDeadline(
  limits: SessionLimits,
  timeoutMs: number,
): number {
  return requestDeadline(limits, Math.min(timeoutMs, MAX_MUTATION_TIMEOUT_MS));
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
  if (!requireFollow) return owners.target(threadId);
  const result = await owners.wait(
    threadId,
    Math.min(
      OWNER_EVIDENCE_TIMEOUT_MS,
      remainingRequestTimeout(limits, deadline),
    ),
  );
  if (result._tag === "Owner") return result.owner;
  owners.invalidate(threadId);
  if (result._tag === "Closed" || result._tag === "Reset") {
    throw new DesktopProtocolError(
      result._tag === "Closed" ? "closed" : "reconnect-failed",
      "operation",
      "not-written",
      "Desktop IPC owner evidence was interrupted by session lifecycle",
    );
  }
  throw new DesktopProtocolError(
    "request-timeout",
    "operation",
    "not-written",
    "Desktop IPC task owner was not observed before submission",
  );
}
