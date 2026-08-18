import { createHash } from "node:crypto";
import { DesktopProtocolError } from "./errors.js";
import type {
  DesktopCapabilities,
  DesktopKnownRejection,
  DesktopProtocolCapability,
  DesktopProtocolFingerprint,
  DesktopStartResult,
  DesktopSteerResult,
} from "./types.js";

export const DESKTOP_INITIALIZE_PARAMS = {
  clientType: "codexhook",
} as const;

export interface DesktopHandshake {
  readonly clientId: string;
  readonly capabilities: DesktopCapabilities;
  readonly appVersion: string | null;
  readonly buildNumber: string | null;
  readonly protocolVersion: number | null;
}

export interface DesktopProtocolAdapter {
  readonly id: string;
  readonly methods: {
    readonly follow: string;
    readonly history: string;
    readonly start: string;
    readonly steer: string;
  };
  readonly version: number;
  decodeStart(value: unknown): DesktopStartResult;
  decodeSteer(value: unknown): DesktopSteerResult;
  followParams(threadId: string): unknown;
  historyParams(threadId: string): unknown;
  startParams(threadId: string, params: Record<string, unknown>): unknown;
  steerParams(threadId: string, params: Record<string, unknown>): unknown;
}

const V1_METHODS = {
  follow: "thread-stream-following-changed",
  history: "thread-follower-load-complete-history",
  start: "thread-follower-start-turn",
  steer: "thread-follower-steer-turn",
} as const;

const CAPABILITY_ALIASES: Record<
  DesktopProtocolCapability,
  ReadonlyArray<string>
> = {
  completeHistory: ["completeHistory", V1_METHODS.history],
  startTurn: ["startTurn", V1_METHODS.start],
  steerTurn: ["steerTurn", V1_METHODS.steer],
  threadStream: ["threadStream", V1_METHODS.follow],
};

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

function optionalBuild(value: unknown): string | null {
  return Number.isSafeInteger(value) ? String(value) : optionalString(value);
}

function explicitProtocolVersion(value: Record<string, unknown>): number | null {
  const protocol = record(value.protocol);
  const candidate = value.protocolVersion ?? protocol?.version;
  if (candidate == null) return null;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw compatibilityError(
      "handshake-malformed",
      "Desktop IPC advertised an invalid protocol version",
    );
  }
  return candidate as number;
}

function advertisedCapabilities(
  value: Record<string, unknown>,
): DesktopCapabilities {
  const candidate = value.serverCapabilities;
  if (candidate == null) {
    return {
      source: "legacy-inferred",
      completeHistory: true,
      startTurn: true,
      steerTurn: true,
      threadStream: true,
    };
  }
  const enabled = new Set<string>();
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (typeof item === "string") enabled.add(item);
    }
  } else {
    const capabilities = record(candidate);
    if (capabilities == null) {
      throw compatibilityError(
        "handshake-malformed",
        "Desktop IPC advertised malformed capabilities",
      );
    }
    for (const [key, item] of Object.entries(capabilities)) {
      if (item === true) enabled.add(key);
    }
  }
  const has = (capability: DesktopProtocolCapability) =>
    CAPABILITY_ALIASES[capability].some((name) => enabled.has(name));
  return {
    source: "advertised",
    completeHistory: has("completeHistory"),
    startTurn: has("startTurn"),
    steerTurn: has("steerTurn"),
    threadStream: has("threadStream"),
  };
}

function compatibilityError(
  failure: "handshake-malformed" | "unknown-protocol-version",
  message: string,
): DesktopProtocolError {
  return new DesktopProtocolError(
    failure,
    "handshake",
    "not-written",
    message,
  );
}

export function decodeDesktopHandshake(value: unknown): DesktopHandshake {
  const result = record(value);
  if (result == null) {
    throw compatibilityError(
      "handshake-malformed",
      "Desktop IPC initialize response is not an object",
    );
  }
  const client = record(result.client);
  const clientId = optionalString(result.clientId) ?? optionalString(client?.id);
  if (clientId == null) {
    throw compatibilityError(
      "handshake-malformed",
      "Desktop IPC initialize response is missing a client id",
    );
  }
  const protocolVersion = explicitProtocolVersion(result);
  if (protocolVersion != null && protocolVersion !== 1) {
    throw compatibilityError(
      "unknown-protocol-version",
      `Desktop IPC protocol version ${protocolVersion} is not supported`,
    );
  }
  const build = record(result.build) ?? record(result.app);
  return {
    clientId,
    capabilities: advertisedCapabilities(result),
    appVersion:
      optionalString(result.appVersion) ?? optionalString(build?.version),
    buildNumber:
      optionalBuild(result.buildNumber) ?? optionalBuild(build?.number),
    protocolVersion,
  };
}

export function selectDesktopAdapter(
  handshake: DesktopHandshake,
): DesktopProtocolAdapter {
  return handshake.protocolVersion == null
    ? makeV1Adapter("desktop-ipc/v1-legacy")
    : makeV1Adapter("desktop-ipc/v1");
}

export function fingerprintDesktopProtocol(
  handshake: DesktopHandshake,
  adapter: DesktopProtocolAdapter,
): DesktopProtocolFingerprint {
  const source = JSON.stringify({
    adapterId: adapter.id,
    appVersion: handshake.appVersion,
    buildNumber: handshake.buildNumber,
    capabilities: handshake.capabilities,
    protocolVersion: handshake.protocolVersion,
  });
  return {
    adapterId: adapter.id,
    appVersion: handshake.appVersion,
    buildNumber: handshake.buildNumber,
    digest: createHash("sha256").update(source).digest("hex").slice(0, 24),
    protocolVersion: handshake.protocolVersion,
  };
}

export function normalizeDesktopRejection(
  value: unknown,
): DesktopKnownRejection {
  if (typeof value !== "string") return "unknown";
  const aliases: ReadonlyArray<readonly [string, DesktopKnownRejection]> = [
    ["thread stream owner became unavailable", "thread-stream-owner-unavailable"],
    ["client-cannot-handle-request", "client-cannot-handle-request"],
    ["request-version-mismatch", "request-version-mismatch"],
    ["no-handler-for-request", "no-handler-for-request"],
    ["no-client-found", "no-client-found"],
    ["client-not-found", "client-not-found"],
    ["thread-role-timeout", "thread-role-timeout"],
  ];
  return aliases.find(([fragment]) => value.includes(fragment))?.[1] ??
    "unknown";
}

function applicationResult(value: unknown): unknown {
  const outer = record(value);
  if (outer == null) return value;
  if ("result" in outer) return outer.result;
  const response = record(outer.response);
  return response != null && "result" in response ? response.result : value;
}

function turnId(value: unknown): string | null {
  const result = record(value);
  if (result == null) return null;
  const queue: Array<{ readonly depth: number; readonly value: unknown }> = [
    { depth: 0, value: result },
  ];
  let visited = 0;
  while (queue.length > 0 && visited < 256) {
    const current = queue.shift();
    if (current == null || current.depth >= 8) continue;
    visited += 1;
    const item = record(current.value);
    if (item == null) continue;
    const found = turnIdFast(item);
    if (found != null) return found;
    for (const child of Object.values(item)) {
      if (queue.length >= 512) break;
      queue.push({ depth: current.depth + 1, value: child });
    }
  }
  return null;
}

function turnIdFast(result: Record<string, unknown>): string | null {
  const turn = record(result.turn);
  const submission = record(result.submission);
  for (const candidate of [result.turnId, turn?.id, submission?.turnId]) {
    if (
      typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= 256
    ) {
      return candidate;
    }
  }
  return null;
}

function malformedAccepted(operation: string): never {
  throw new DesktopProtocolError(
    "response-malformed",
    "operation",
    "written",
    `Desktop IPC accepted ${operation} with an incompatible response shape`,
  );
}

function makeV1Adapter(id: string): DesktopProtocolAdapter {
  return {
    id,
    methods: V1_METHODS,
    version: 1,
    followParams: (threadId) => ({
      conversationId: threadId,
      hostId: "local",
      following: true,
    }),
    historyParams: (threadId) => ({ conversationId: threadId }),
    startParams: (threadId, params) => ({
      conversationId: threadId,
      turnStartParams: params,
    }),
    steerParams: (threadId, params) => ({
      conversationId: threadId,
      ...params,
    }),
    decodeStart: (value) => {
      const result = applicationResult(value);
      const observedTurnId = turnId(result);
      if (observedTurnId == null) return malformedAccepted("start-turn");
      return { result, turnId: observedTurnId };
    },
    decodeSteer: (value) => {
      const result = applicationResult(value);
      return { result, turnId: turnId(result) };
    },
  };
}
