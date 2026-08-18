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
    await restoreFollowedThreads(raw, adapter, profile, followedThreads);
  }
  return { adapter, profile, raw };
}

async function restoreFollowedThreads(
  raw: RawDesktopConnection,
  adapter: DesktopProtocolAdapter,
  profile: DesktopProtocolProfile,
  followedThreads: ReadonlySet<string>,
): Promise<void> {
  if (followedThreads.size > 0 && !profile.capabilities.threadStream) {
    throw desktopReconnectError(
      "Desktop IPC reconnect cannot restore followed tasks",
    );
  }
  try {
    for (const threadId of followedThreads) {
      await raw.broadcast(
        adapter.methods.follow,
        adapter.followParams(threadId),
        adapter.version,
      );
    }
  } catch {
    throw desktopReconnectError(
      "Desktop IPC reconnect could not restore followed tasks",
    );
  }
}
