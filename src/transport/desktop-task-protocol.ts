import {
  DesktopIpcClient,
  type IpcEnvelope,
} from "./desktop-ipc-client.js";
import type { Turn } from "./protocol.js";

const IPC_VERSION = {
  following: 1,
  history: 1,
  interrupt: 1,
  start: 1,
  steer: 1,
} as const;

export interface DesktopTurnEntity {
  readonly key: string;
  readonly turn: Turn;
}

export type DesktopTurnDelta =
  | { readonly _tag: "Upsert"; readonly entity: DesktopTurnEntity }
  | { readonly _tag: "Bind"; readonly key: string; readonly turnId: string }
  | {
      readonly _tag: "Status";
      readonly key: string;
      readonly status: Turn["status"];
    }
  | {
      readonly _tag: "Error";
      readonly key: string;
      readonly error: Turn["error"];
    }
  | { readonly _tag: "Remove"; readonly key: string };

export type DesktopTaskChange =
  | {
      readonly _tag: "Snapshot";
      readonly revision: number | null;
      readonly entities: ReadonlyArray<DesktopTurnEntity>;
      readonly deliveryIds: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Patches";
      readonly baseRevision: number | null;
      readonly revision: number | null;
      readonly deltas: ReadonlyArray<DesktopTurnDelta>;
      readonly deliveryIds: ReadonlyArray<string>;
    };

export interface DesktopCommand {
  readonly kind: "start" | "steer" | "interrupt";
  readonly threadId: string;
  readonly expectedTurnId?: string;
  readonly clientUserMessageId?: string;
  readonly input?: unknown;
}

export type DesktopCommandReply =
  | {
      readonly _tag: "Accepted";
      readonly result: unknown;
      readonly turnId: string | null;
    }
  | {
      readonly _tag: "Rejected";
      readonly reason: string;
      readonly notWritten: boolean;
    };

/** Connection-scoped seam consumed by semantic task attachment. */
export interface DesktopTaskProtocol {
  readonly connected: boolean;
  readonly close: () => void;
  readonly follow: (threadId: string) => Promise<void>;
  readonly inject: (
    command: DesktopCommand,
  ) => Promise<DesktopCommandReply>;
  readonly loadHistory: (threadId: string) => Promise<void>;
  readonly onChange: (
    listener: (threadId: string, change: DesktopTaskChange) => void,
  ) => () => void;
  readonly onDisconnect: (
    listener: (error: Error) => void,
  ) => () => void;
}

export type DesktopProtocolConnector = () => Promise<DesktopTaskProtocol>;

const METHODS = {
  interrupt: "thread-follower-interrupt-turn",
  start: "thread-follower-start-turn",
  steer: "thread-follower-steer-turn",
} as const;

function safeRejection(error: string): boolean {
  return [
    "no-client-found",
    "client-not-found",
    "client-cannot-handle-request",
    "request-version-mismatch",
    "no-handler-for-request",
    "thread stream owner became unavailable",
    "thread-role-timeout",
  ].some((value) => error.includes(value));
}

function readChange(
  message: IpcEnvelope,
): { readonly threadId: string; readonly change: DesktopTaskChange } | null {
  if (
    message.method !== "thread-stream-state-changed" ||
    message.params == null ||
    typeof message.params !== "object"
  ) return null;
  const params = message.params as {
    readonly conversationId?: unknown;
    readonly change?: unknown;
  };
  if (typeof params.conversationId !== "string") return null;
  const change = record(params.change);
  if (change?.type === "snapshot") {
    return {
      threadId: params.conversationId,
      change: {
        _tag: "Snapshot",
        revision: readRevision(change.revision),
        entities: snapshotEntities(change.conversationState),
        deliveryIds: deliveryIds(snapshotEntityValues(change.conversationState)),
      },
    };
  }
  if (change?.type !== "patches") return null;
  const patches = Array.isArray(change.patches) ? change.patches : [];
  return {
    threadId: params.conversationId,
    change: {
      _tag: "Patches",
      baseRevision: readRevision(change.baseRevision),
      revision: readRevision(change.revision),
      deltas: patches.flatMap(readDelta),
      deliveryIds: patches.flatMap(patchDeliveryIds),
    },
  };
}

export class DesktopIpcProtocol implements DesktopTaskProtocol {
  private readonly changes = new Set<
    (threadId: string, change: DesktopTaskChange) => void
  >();
  private readonly disconnects = new Set<(error: Error) => void>();

  private constructor(private readonly client: DesktopIpcClient) {
    client.onBroadcast((message) => {
      const event = readChange(message);
      if (event == null) return;
      for (const listener of this.changes) {
        listener(event.threadId, event.change);
      }
    });
    client.onDisconnect((error) => {
      for (const listener of this.disconnects) listener(error);
    });
  }

  static async connect(socketPath: string): Promise<DesktopIpcProtocol> {
    return new DesktopIpcProtocol(
      await DesktopIpcClient.connect(socketPath),
    );
  }

  get connected(): boolean {
    return this.client.alive;
  }

  close(): void {
    this.client.close();
  }

  async follow(threadId: string): Promise<void> {
    this.client.broadcast(
      "thread-stream-following-changed",
      { conversationId: threadId, hostId: "local", following: true },
      IPC_VERSION.following,
    );
  }

  async loadHistory(threadId: string): Promise<void> {
    const reply = await this.client.request(
      "thread-follower-load-complete-history",
      { conversationId: threadId },
      IPC_VERSION.history,
      30_000,
    );
    if (reply.resultType === "error") {
      throw new Error(reply.error ?? "Desktop history request failed");
    }
  }

  async inject(command: DesktopCommand): Promise<DesktopCommandReply> {
    const reply = await this.client.request(
      METHODS[command.kind],
      commandParams(command),
      IPC_VERSION[command.kind],
      30_000,
    );
    if (reply.resultType === "error") {
      const reason = reply.error ?? "Desktop rejected the request";
      return {
        _tag: "Rejected",
        reason,
        notWritten: safeRejection(reason),
      };
    }
    const outer = reply.result as
      | { readonly result?: unknown }
      | undefined;
    return {
      _tag: "Accepted",
      result: outer?.result,
      turnId: nestedTurnId(outer?.result),
    };
  }

  onChange(
    listener: (threadId: string, change: DesktopTaskChange) => void,
  ): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }
}

function commandParams(command: DesktopCommand): unknown {
  if (command.kind === "start") {
    return {
      conversationId: command.threadId,
      turnStartParams: {
        clientUserMessageId: command.clientUserMessageId,
        input: command.input,
      },
    };
  }
  if (command.kind === "steer") {
    return {
      conversationId: command.threadId,
      expectedTurnId: command.expectedTurnId,
      clientUserMessageId: command.clientUserMessageId,
      input: command.input,
    };
  }
  return {
    conversationId: command.threadId,
    turnId: command.expectedTurnId,
  };
}

function snapshotEntities(value: unknown): ReadonlyArray<DesktopTurnEntity> {
  const entities = snapshotEntityValues(value);
  return Object.entries(entities).flatMap(([key, entity]) => {
    const turn = readTurn(entity);
    return turn == null ? [] : [{ key, turn }];
  });
}

function snapshotEntityValues(value: unknown): Record<string, unknown> {
  const history = record(record(record(value)?.turnHistory)?.history);
  return record(history?.entitiesByKey) ?? {};
}

function readDelta(value: unknown): ReadonlyArray<DesktopTurnDelta> {
  const patch = record(value);
  const path = Array.isArray(patch?.path) ? patch.path : [];
  const marker = path.indexOf("entitiesByKey");
  const key = marker < 0 ? undefined : path[marker + 1];
  if (typeof key !== "string") return [];
  const root = path.length === marker + 2;
  if (patch?.op === "remove" && root) return [{ _tag: "Remove", key }];
  if (root) {
    const turn = readTurn(patch?.value);
    return turn == null ? [] : [{ _tag: "Upsert", entity: { key, turn } }];
  }
  if (path.at(-1) === "turnId" && typeof patch?.value === "string") {
    return [{ _tag: "Bind", key, turnId: patch.value }];
  }
  if (path.at(-1) === "status") {
    return [{ _tag: "Status", key, status: normalizeStatus(patch?.value) }];
  }
  if (path.at(-1) === "error") {
    return [{ _tag: "Error", key, error: readError(patch?.value) }];
  }
  return [];
}

function readTurn(value: unknown): Turn | null {
  const entity = record(value);
  if (typeof entity?.turnId !== "string") return null;
  return {
    id: entity.turnId,
    status: normalizeStatus(entity.status),
    error: readError(entity.error),
  };
}

function deliveryIds(value: unknown): ReadonlyArray<string> {
  const found = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next == null || typeof next !== "object") continue;
    if (Array.isArray(next)) {
      pending.push(...next);
      continue;
    }
    for (const [key, child] of Object.entries(next)) {
      if (key === "clientUserMessageId" && typeof child === "string") {
        found.add(child);
      } else {
        pending.push(child);
      }
    }
  }
  return [...found];
}

function patchDeliveryIds(value: unknown): ReadonlyArray<string> {
  const patch = record(value);
  if (patch == null) return [];
  const path = Array.isArray(patch.path) ? patch.path : [];
  const direct = path.at(-1) === "clientUserMessageId" &&
      typeof patch.value === "string"
    ? [patch.value]
    : [];
  return [...direct, ...deliveryIds(patch.value)];
}

function nestedTurnId(value: unknown, depth = 0): string | null {
  if (depth > 32 || value == null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.turnId === "string") return source.turnId;
  const turn = record(source.turn);
  if (typeof turn?.id === "string") return turn.id;
  for (const child of Object.values(source)) {
    const found = nestedTurnId(child, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function normalizeStatus(value: unknown): Turn["status"] {
  return value === "completed" ||
    value === "interrupted" ||
    value === "failed"
    ? value
    : "inProgress";
}

function readError(value: unknown): Turn["error"] {
  if (value == null || typeof value !== "object") return null;
  const message = (value as { readonly message?: unknown }).message;
  return typeof message === "string" ? { message } : {};
}
