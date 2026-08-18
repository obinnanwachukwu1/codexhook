import type { IpcEnvelope } from "./desktop-ipc-client.js";
import type { Turn } from "./protocol.js";
import type {
  DesktopTaskChange,
  DesktopTurnDelta,
  DesktopTurnEntity,
} from "./desktop-task-protocol.js";

export function readDesktopChange(
  message: IpcEnvelope,
): { readonly threadId: string; readonly change: DesktopTaskChange } | null {
  if (
    message.method !== "thread-stream-state-changed" ||
    message.params == null || typeof message.params !== "object"
  ) return null;
  const params = message.params as {
    readonly conversationId?: unknown;
    readonly change?: unknown;
  };
  if (typeof params.conversationId !== "string") return null;
  const change = record(params.change);
  if (change?.type === "snapshot") {
    const entities = snapshotEntityValues(change.conversationState);
    return {
      threadId: params.conversationId,
      change: {
        _tag: "Snapshot",
        revision: readRevision(change.revision),
        entities: snapshotEntities(entities),
        deliveryIds: deliveryIds(entities),
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

function snapshotEntities(
  entities: Record<string, unknown>,
): ReadonlyArray<DesktopTurnEntity> {
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
  if (!isTurnEntityPath(path)) return [];
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
  if (!isTurnEntityPath(path)) return [];
  const direct = path.at(-1) === "clientUserMessageId" &&
      typeof patch.value === "string"
    ? [patch.value]
    : [];
  return [...direct, ...deliveryIds(patch.value)];
}

function isTurnEntityPath(path: ReadonlyArray<unknown>): boolean {
  return path.some((part, index) =>
    part === "turnHistory" && path[index + 1] === "history" &&
    path[index + 2] === "entitiesByKey"
  );
}

export function acceptedTurnId(value: unknown): string | null {
  const result = record(value);
  if (result == null) return null;
  const turn = record(result.turn);
  const submission = record(result.submission);
  for (const candidate of [result.turnId, turn?.id, submission?.turnId]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
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
  return value === "completed" || value === "interrupted" || value === "failed"
    ? value
    : "inProgress";
}

function readError(value: unknown): Turn["error"] {
  if (value == null || typeof value !== "object") return null;
  const message = (value as { readonly message?: unknown }).message;
  return typeof message === "string" ? { message } : {};
}
