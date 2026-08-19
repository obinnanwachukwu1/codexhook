import { desktopReconnectError } from "./errors.js";
import type { SessionLimits } from "./limits.js";
import {
  followDesktopThread,
  type DesktopFollowConnection,
} from "./session-follow.js";
import { remainingRequestTimeout } from "./session-request.js";
import { DesktopThreadOwners } from "./thread-owners.js";

export async function refreshDesktopOwner(
  connection: DesktopFollowConnection,
  followedThreads: Set<string>,
  owners: DesktopThreadOwners,
  limits: SessionLimits,
  threadId: string,
  deadline: number,
): Promise<void> {
  if (!followedThreads.has(threadId) || !owners.needsRefresh(threadId)) return;
  const timeoutMs = remainingRequestTimeout(limits, deadline);
  owners.beginRefresh(threadId);
  try {
    await followDesktopThread(
      connection,
      followedThreads,
      owners,
      threadId,
      timeoutMs,
    );
  } catch (cause) {
    owners.invalidate(threadId);
    throw desktopReconnectError("Desktop IPC owner refresh failed", cause);
  }
}
