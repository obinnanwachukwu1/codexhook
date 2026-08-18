import type { IpcEnvelope } from "./desktop-ipc-client.js";
import type { Turn } from "./protocol.js";

interface Patch {
  readonly op?: string;
  readonly path?: ReadonlyArray<string | number>;
  readonly value?: unknown;
}

export type DesktopStateDiagnostic =
  | "revision_gap"
  | "resynchronized"
  | "reordered_patch"
  | "stale_active_turn";

type StatePhase =
  | "empty"
  | "ready"
  | "resync-requested"
  | "resync-in-flight";

export class DesktopThreadState {
  private readonly entityTurns = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private phase: StatePhase = "empty";
  private revision: number | null = null;
  private readonly turns = new Map<string, Turn>();

  constructor(
    readonly threadId: string,
    private readonly onDiagnostic: (
      event: DesktopStateDiagnostic,
    ) => void = () => undefined,
  ) {}

  snapshot(): ReadonlyArray<Turn> {
    return [...this.turns.values()];
  }

  get ready(): boolean {
    return this.phase === "ready";
  }

  takeResyncRequest(): boolean {
    if (this.phase !== "resync-requested") return false;
    this.phase = "resync-in-flight";
    return true;
  }

  turn(turnId: string): Turn | undefined {
    return this.turns.get(turnId);
  }

  observeTurn(turnId: string): void {
    if (this.turns.has(turnId)) return;
    this.turns.set(turnId, {
      id: turnId,
      status: "inProgress",
      error: null,
    });
  }

  waitFor(
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const listener = () => {
        if (!predicate()) return;
        cleanup();
        resolve();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Desktop thread state timed out"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
  }

  apply(message: IpcEnvelope): void {
    if (
      message.method !== "thread-stream-state-changed" ||
      message.params == null ||
      typeof message.params !== "object"
    ) return;
    const params = message.params as {
      conversationId?: unknown;
      change?: unknown;
    };
    if (params.conversationId !== this.threadId) return;
    const change = params.change as {
      type?: string;
      baseRevision?: number;
      revision?: number;
      conversationState?: unknown;
      patches?: ReadonlyArray<Patch>;
    } | undefined;
    if (change?.type === "snapshot") {
      const resynchronized = this.phase === "resync-requested" ||
        this.phase === "resync-in-flight";
      const staleActiveTurns = [...this.turns.values()]
        .filter((turn) => turn.status === "inProgress")
        .map((turn) => turn.id);
      if (typeof change.revision === "number") {
        this.revision = change.revision;
      }
      this.phase = "ready";
      this.entityTurns.clear();
      this.turns.clear();
      this.readSnapshot(change.conversationState);
      if (staleActiveTurns.some((turnId) => !this.turns.has(turnId))) {
        this.onDiagnostic("stale_active_turn");
      }
      if (resynchronized) this.onDiagnostic("resynchronized");
    } else if (change?.type === "patches") {
      if (
        this.revision != null &&
        change.baseRevision !== this.revision
      ) {
        this.phase = "resync-requested";
        this.onDiagnostic("revision_gap");
        for (const listener of this.listeners) listener();
        return;
      }
      const patches = change.patches ?? [];
      if (this.hasReorderedEntityPatch(patches)) {
        this.onDiagnostic("reordered_patch");
      }
      for (const patch of patches.filter(isTurnIdPatch)) this.readPatch(patch);
      for (const patch of patches.filter((patch) => !isTurnIdPatch(patch))) {
        this.readPatch(patch);
      }
      if (typeof change.revision === "number") {
        this.revision = change.revision;
      }
    }
    for (const listener of this.listeners) listener();
  }

  private readSnapshot(value: unknown): void {
    if (value == null || typeof value !== "object") return;
    const state = value as {
      turnHistory?: {
        history?: { entitiesByKey?: Record<string, unknown> };
      };
    };
    const entities =
      state.turnHistory?.history?.entitiesByKey ?? {};
    for (const [key, entity] of Object.entries(entities)) {
      this.readEntity(entity, key);
    }
  }

  private readPatch(patch: Patch): void {
    const path = patch.path ?? [];
    if (!path.includes("entitiesByKey")) return;
    const keyIndex = path.indexOf("entitiesByKey") + 1;
    const key = path[keyIndex];
    if (
      path.at(-1) === "turnId" &&
      typeof key === "string" &&
      typeof patch.value === "string"
    ) {
      this.entityTurns.set(key, patch.value);
      this.observeTurn(patch.value);
      return;
    }
    if (path.at(-1) === "status") {
      const turnId =
        typeof key === "string" ? this.entityTurns.get(key) : null;
      const existing = turnId == null ? null : this.turns.get(turnId);
      if (typeof patch.value !== "string") return;
      const status = normalizeStatus(patch.value);
      if (existing != null) {
        this.turns.set(existing.id, {
          ...existing,
          status,
        });
      }
      return;
    }
    this.readEntity(patch.value, typeof key === "string" ? key : undefined);
  }

  private readEntity(value: unknown, entityKey?: string): void {
    if (value == null || typeof value !== "object") return;
    const entity = value as {
      turnId?: unknown;
      status?: unknown;
      error?: { message?: string } | null;
    };
    if (typeof entity.turnId !== "string") return;
    if (entityKey != null) this.entityTurns.set(entityKey, entity.turnId);
    this.turns.set(entity.turnId, {
      id: entity.turnId,
      status: normalizeStatus(entity.status),
      error: entity.error,
    });
  }

  private hasReorderedEntityPatch(patches: ReadonlyArray<Patch>): boolean {
    const turnIdIndex = new Map<string, number>();
    patches.forEach((patch, index) => {
      const key = entityKey(patch);
      if (key != null && isTurnIdPatch(patch)) turnIdIndex.set(key, index);
    });
    return patches.some((patch, index) => {
      const key = entityKey(patch);
      const association = key == null ? undefined : turnIdIndex.get(key);
      return key != null &&
        patch.path?.at(-1) === "status" &&
        this.entityTurns.get(key) == null &&
        association != null &&
        index < association;
    });
  }
}

function entityKey(patch: Patch): string | null {
  const path = patch.path ?? [];
  const index = path.indexOf("entitiesByKey");
  const key = index < 0 ? undefined : path[index + 1];
  return typeof key === "string" ? key : null;
}

function isTurnIdPatch(patch: Patch): boolean {
  return entityKey(patch) != null &&
    patch.path?.at(-1) === "turnId" &&
    typeof patch.value === "string";
}

function normalizeStatus(value: unknown): Turn["status"] {
  return value === "completed" ||
    value === "interrupted" ||
    value === "failed"
    ? value
    : "inProgress";
}
