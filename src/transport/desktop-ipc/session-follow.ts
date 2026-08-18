import type { DesktopProtocolAdapter } from "./adapters.js";
import { DesktopThreadOwners } from "./thread-owners.js";
import type { RawDesktopConnection } from "./wire.js";
import { DesktopProtocolError } from "./errors.js";

interface FollowConnection {
  readonly adapter: Pick<
    DesktopProtocolAdapter,
    "followParams" | "methods" | "version"
  >;
  readonly raw: Pick<RawDesktopConnection, "broadcast">;
}

export async function followDesktopThread(
  connection: FollowConnection,
  followedThreads: Set<string>,
  owners: DesktopThreadOwners,
  threadId: string,
  timeoutMs?: number,
): Promise<void> {
  const added = !followedThreads.has(threadId);
  followedThreads.add(threadId);
  try {
    const broadcast = connection.raw.broadcast(
      connection.adapter.methods.follow,
      connection.adapter.followParams(threadId),
      connection.adapter.version,
    );
    await (timeoutMs == null ? broadcast : boundedFollow(broadcast, timeoutMs));
  } catch (cause) {
    if (added) {
      followedThreads.delete(threadId);
      owners.drop(threadId);
    }
    throw cause;
  }
}

async function boundedFollow(
  broadcast: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DesktopProtocolError(
      "request-timeout",
      "operation",
      "unknown",
      "Desktop IPC follow did not flush before the request deadline",
    )), timeoutMs);
  });
  try {
    await Promise.race([broadcast, timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
