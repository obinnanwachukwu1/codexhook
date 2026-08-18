import type { Turn } from "./protocol.js";
import type { DesktopChange } from "./desktop-protocol.js";

type ConnectionState = "disconnected" | "connecting" | "connected";
type AttachmentState = "detached" | "following" | "synchronized";
type ActivityState = "unknown" | "idle" | "active";
type InjectionState =
  | "idle"
  | "injecting"
  | "confirmed"
  | "uncertain"
  | "rejected";

export interface DesktopTaskSnapshot {
  readonly connection: ConnectionState;
  readonly attachment: AttachmentState;
  readonly activity: ActivityState;
  readonly injection: InjectionState;
  readonly generation: number;
  readonly revision: number | null;
  readonly turns: ReadonlyArray<Turn>;
}

export type DesktopChangeResult = "applied" | "ignored" | "resync";

export class DesktopThreadState {
  private attachment: AttachmentState = "detached";
  private connection: ConnectionState = "disconnected";
  private readonly entityTurns = new Map<string, string>();
  private generation = 0;
  private initialized = false;
  private injection: InjectionState = "idle";
  private readonly listeners = new Set<() => void>();
  private revisionValue: number | null = null;
  private readonly turns = new Map<string, Turn>();

  constructor(readonly threadId: string) {}

  get ready(): boolean {
    return this.initialized && this.attachment === "synchronized";
  }

  get revision(): number | null {
    return this.revisionValue;
  }

  snapshot(): ReadonlyArray<Turn> {
    return [...this.turns.values()];
  }

  evidence(): DesktopTaskSnapshot {
    return {
      connection: this.connection,
      attachment: this.attachment,
      activity: !this.ready
        ? "unknown"
        : this.activeTurn() == null ? "idle" : "active",
      injection: this.injection,
      generation: this.generation,
      revision: this.revisionValue,
      turns: this.snapshot(),
    };
  }

  activeTurn(): Turn | undefined {
    return [...this.turns.values()]
      .reverse()
      .find((turn) => turn.status === "inProgress");
  }

  turn(turnId: string): Turn | undefined {
    return this.turns.get(turnId);
  }

  beginConnecting(): void {
    this.connection = "connecting";
    this.attachment = "detached";
    this.initialized = false;
    this.emit();
  }

  beginFollowing(generation: number): void {
    this.connection = "connected";
    this.attachment = "following";
    this.generation = generation;
    this.initialized = false;
    this.revisionValue = null;
    this.emit();
  }

  beginResync(): void {
    this.attachment = "following";
    this.initialized = false;
    this.emit();
  }

  disconnected(): void {
    this.connection = "disconnected";
    this.attachment = "detached";
    this.initialized = false;
    if (this.injection === "injecting") this.injection = "uncertain";
    this.emit();
  }

  beginInjection(): void {
    this.injection = "injecting";
    this.emit();
  }

  finishInjection(result: "confirmed" | "uncertain" | "rejected"): void {
    this.injection = result;
    this.emit();
  }

  apply(change: DesktopChange, generation: number): DesktopChangeResult {
    if (generation !== this.generation || this.connection !== "connected") {
      return "ignored";
    }
    if (change.type === "snapshot") return this.applySnapshot(change);
    if (change.type !== "patches") return "ignored";
    return this.applyPatches(change);
  }

  waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
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

  private applySnapshot(change: DesktopChange): DesktopChangeResult {
    if (!validRevision(change.revision)) return this.requestResync();
    this.revisionValue = change.revision;
    this.entityTurns.clear();
    this.turns.clear();
    this.readSnapshot(change.conversationState);
    this.initialized = true;
    this.attachment = "synchronized";
    this.emit();
    return "applied";
  }

  private applyPatches(change: DesktopChange): DesktopChangeResult {
    if (!this.initialized || this.revisionValue == null) {
      return this.requestResync();
    }
    if (!validRevision(change.baseRevision) ||
        !validRevision(change.revision)) {
      return this.requestResync();
    }
    if (change.revision <= this.revisionValue) return "ignored";
    if (
      change.baseRevision !== this.revisionValue ||
      change.revision <= change.baseRevision
    ) return this.requestResync();
    for (const patch of change.patches ?? []) this.readPatch(patch);
    this.revisionValue = change.revision;
    this.emit();
    return "applied";
  }

  private requestResync(): DesktopChangeResult {
    this.beginResync();
    return "resync";
  }

  private readSnapshot(value: unknown): void {
    if (value == null || typeof value !== "object") return;
    const state = value as {
      turnHistory?: {
        history?: { entitiesByKey?: Record<string, unknown> };
      };
    };
    const entities = state.turnHistory?.history?.entitiesByKey ?? {};
    for (const [key, entity] of Object.entries(entities)) {
      this.readEntity(entity, key);
    }
  }

  private readPatch(
    patch: NonNullable<DesktopChange["patches"]>[number],
  ): void {
    const path = patch.path ?? [];
    const marker = path.indexOf("entitiesByKey");
    if (marker < 0) return;
    const key = path[marker + 1];
    if (typeof key !== "string") return;
    if (patch.op === "remove" && path.length === marker + 2) {
      const turnId = this.entityTurns.get(key);
      this.entityTurns.delete(key);
      if (turnId != null) this.turns.delete(turnId);
      return;
    }
    if (path.at(-1) === "turnId" && typeof patch.value === "string") {
      this.entityTurns.set(key, patch.value);
      this.observeTurn(patch.value);
      return;
    }
    const turnId = this.entityTurns.get(key);
    const existing = turnId == null ? undefined : this.turns.get(turnId);
    if (path.at(-1) === "status" && existing != null) {
      this.turns.set(existing.id, {
        ...existing,
        status: normalizeStatus(patch.value),
      });
      return;
    }
    if (path.at(-1) === "error" && existing != null) {
      this.turns.set(existing.id, {
        ...existing,
        error: readError(patch.value),
      });
      return;
    }
    this.readEntity(patch.value, key);
  }

  private readEntity(value: unknown, entityKey: string): void {
    if (value == null || typeof value !== "object") return;
    const entity = value as {
      turnId?: unknown;
      status?: unknown;
      error?: unknown;
    };
    if (typeof entity.turnId !== "string") return;
    this.entityTurns.set(entityKey, entity.turnId);
    this.turns.set(entity.turnId, {
      id: entity.turnId,
      status: normalizeStatus(entity.status),
      error: readError(entity.error),
    });
  }

  private observeTurn(turnId: string): void {
    if (this.turns.has(turnId)) return;
    this.turns.set(turnId, {
      id: turnId,
      status: "inProgress",
      error: null,
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
