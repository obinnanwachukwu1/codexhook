import {
  decodeDesktopHandshake,
  DESKTOP_INITIALIZE_PARAMS,
  fingerprintDesktopProtocol,
  selectDesktopAdapter,
  type DesktopProtocolAdapter,
} from "./adapters.js";
import { desktopReconnectError, DesktopProtocolError } from "./errors.js";
import type {
  DesktopProtocolObservation,
  DesktopProtocolProfile,
} from "./types.js";
import { RawDesktopConnection } from "./wire.js";
import { boundedFollow } from "./session-follow.js";

export interface NegotiatedConnection {
  readonly adapter: DesktopProtocolAdapter;
  readonly profile: DesktopProtocolProfile;
  readonly raw: RawDesktopConnection;
}

export async function negotiateDesktopConnection(
  raw: RawDesktopConnection,
  handshakeTimeoutMs: number,
  reconnected: boolean,
  followedThreads: ReadonlySet<string>,
  emit: (observation: DesktopProtocolObservation) => void,
  assertOpen: () => void,
  restoreDeadline?: number,
): Promise<NegotiatedConnection> {
  const response = await raw.request(
    "initialize",
    DESKTOP_INITIALIZE_PARAMS,
    0,
    handshakeTimeoutMs,
  );
  assertOpen();
  if (response.resultType === "error") {
    throw new DesktopProtocolError(
      "handshake-malformed",
      "handshake",
      "not-written",
      "Desktop IPC initialize request was rejected",
    );
  }
  if (response.resultType != null && response.resultType !== "success") {
    throw new DesktopProtocolError(
      "handshake-malformed",
      "handshake",
      "not-written",
      "Desktop IPC initialize response has an unknown result type",
    );
  }
  const handshake = decodeDesktopHandshake(response.result);
  raw.setInitializedClientId(handshake.clientId);
  const adapter = selectDesktopAdapter(handshake);
  const profile = {
    compatibility: adapter.compatibility,
    capabilities: handshake.capabilities,
    fingerprint: fingerprintDesktopProtocol(handshake, adapter),
  };
  if (reconnected) {
    emit({ _tag: "Reconnecting", profile });
    await restoreFollowedThreads(
      raw,
      adapter,
      profile,
      followedThreads,
      restoreDeadline,
    );
  }
  return { adapter, profile, raw };
}

export async function restoreFollowedThreads(
  raw: Pick<RawDesktopConnection, "broadcast">,
  adapter: DesktopProtocolAdapter,
  profile: DesktopProtocolProfile,
  followedThreads: ReadonlySet<string>,
  deadline?: number,
): Promise<void> {
  if (followedThreads.size > 0 && !profile.capabilities.threadStream) {
    throw desktopReconnectError(
      "Desktop IPC reconnect cannot restore followed tasks",
    );
  }
  try {
    for (const threadId of followedThreads) {
      const broadcast = raw.broadcast(
        adapter.methods.follow,
        adapter.followParams(threadId),
        adapter.version,
      );
      await (deadline == null
        ? broadcast
        : boundedFollow(broadcast, remainingRestoreTime(deadline)));
    }
  } catch {
    throw desktopReconnectError(
      "Desktop IPC reconnect could not restore followed tasks",
    );
  }
}

function remainingRestoreTime(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) {
    throw desktopReconnectError(
      "Desktop IPC reconnect follow budget expired",
    );
  }
  return remaining;
}
