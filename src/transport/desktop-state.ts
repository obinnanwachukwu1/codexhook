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

export class DesktopThreadState {
  private readonly entityTurns = new Map<string, string>();
  private readonly pendingStatuses = new Map<string, Turn["status"]>();
  private initialized = false;
  private readonly listeners = new Set<() => void>();
  private resync = false;
  private resyncPending = false;
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
    return this.initialized;
  }

  takeResyncRequest(): boolean {
    if (!this.resync) return false;
    this.resync = false;
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
      const staleActiveTurns = [...this.turns.values()]
        .filter((turn) => turn.status === "inProgress")
        .map((turn) => turn.id);
      if (typeof change.revision === "number") {
        this.revision = change.revision;
      }
      this.initialized = true;
      this.entityTurns.clear();
      this.pendingStatuses.clear();
      this.turns.clear();
      this.readSnapshot(change.conversationState);
      if (staleActiveTurns.some((turnId) => !this.turns.has(turnId))) {
        this.onDiagnostic("stale_active_turn");
      }
      if (this.resyncPending) {
        this.resyncPending = false;
        this.onDiagnostic("resynchronized");
      }
    } else if (change?.type === "patches") {
      if (
        this.revision != null &&
        change.baseRevision !== this.revision
      ) {
        this.initialized = false;
        this.resync = true;
        this.resyncPending = true;
        this.onDiagnostic("revision_gap");
        for (const listener of this.listeners) listener();
        return;
      }
      for (const patch of change.patches ?? []) this.readPatch(patch);
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
      const pendingStatus = this.pendingStatuses.get(key);
      this.turns.set(patch.value, {
        id: patch.value,
        status: pendingStatus ?? "inProgress",
        error: null,
      });
      this.pendingStatuses.delete(key);
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
      } else if (typeof key === "string") {
        this.pendingStatuses.set(key, status);
        this.onDiagnostic("reordered_patch");
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
}

function normalizeStatus(value: unknown): Turn["status"] {
  return value === "completed" ||
    value === "interrupted" ||
    value === "failed"
    ? value
    : "inProgress";
}
