import type { DesktopProtocolAdapter } from "./adapters.js";
import { DesktopThreadOwners } from "./thread-owners.js";
import type { RawDesktopConnection } from "./wire.js";

interface FollowConnection {
  readonly adapter: DesktopProtocolAdapter;
  readonly raw: RawDesktopConnection;
}

export async function followDesktopThread(
  connection: FollowConnection,
  followedThreads: Set<string>,
  owners: DesktopThreadOwners,
  threadId: string,
): Promise<void> {
  followedThreads.add(threadId);
  try {
    await connection.raw.broadcast(
      connection.adapter.methods.follow,
      connection.adapter.followParams(threadId),
      connection.adapter.version,
    );
  } catch (cause) {
    followedThreads.delete(threadId);
    owners.drop(threadId);
    throw cause;
  }
}
