import type { DesktopProtocolAdapter } from "./adapters.js";
import { DesktopThreadOwners } from "./thread-owners.js";
import type { RawDesktopConnection } from "./wire.js";

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
): Promise<void> {
  const added = !followedThreads.has(threadId);
  followedThreads.add(threadId);
  try {
    await connection.raw.broadcast(
      connection.adapter.methods.follow,
      connection.adapter.followParams(threadId),
      connection.adapter.version,
    );
  } catch (cause) {
    if (added) {
      followedThreads.delete(threadId);
      owners.drop(threadId);
    }
    throw cause;
  }
}
