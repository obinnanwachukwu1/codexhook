import type { Turn } from "./protocol.js";
import type {
  DesktopTaskChange,
  DesktopTurnDelta,
} from "./desktop-task-protocol.js";

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
  private attachmentValue: AttachmentState = "detached";
  private connectionValue: ConnectionState = "disconnected";
  private readonly deliveryIds = new Set<string>();
  private readonly entityTurns = new Map<string, string>();
  private generationValue = 0;
  private initialized = false;
  private injection: InjectionState = "idle";
  private readonly listeners = new Set<() => void>();
  private revisionValue: number | null = null;
  private readonly turns = new Map<string, Turn>();

  constructor(readonly threadId: string) {}

  get attachment(): AttachmentState {
    return this.attachmentValue;
  }

  get connection(): ConnectionState {
    return this.connectionValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  get ready(): boolean {
    return this.initialized && this.attachmentValue === "synchronized";
  }

  get revision(): number | null {
    return this.revisionValue;
  }

  turnsSnapshot(): ReadonlyArray<Turn> {
    return [...this.turns.values()];
  }

  evidence(): DesktopTaskSnapshot {
    return {
      connection: this.connectionValue,
      attachment: this.attachmentValue,
      activity: !this.ready
        ? "unknown"
        : this.activeTurn() == null ? "idle" : "active",
      injection: this.injection,
      generation: this.generationValue,
      revision: this.revisionValue,
      turns: this.turnsSnapshot(),
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

  hasDelivery(deliveryId: string): boolean {
    return this.deliveryIds.has(deliveryId);
  }

  beginConnecting(): void {
    this.connectionValue = "connecting";
    this.attachmentValue = "detached";
    this.initialized = false;
    this.emit();
  }

  beginFollowing(generation: number): void {
    this.connectionValue = "connected";
    this.attachmentValue = "following";
    this.generationValue = generation;
    this.initialized = false;
    this.revisionValue = null;
    this.clearObservedState();
    this.emit();
  }

  beginResync(): void {
    this.attachmentValue = "following";
    this.initialized = false;
    this.emit();
  }

  disconnected(): void {
    this.connectionValue = "disconnected";
    this.attachmentValue = "detached";
    this.initialized = false;
    if (this.injection === "injecting") this.injection = "uncertain";
    this.emit();
  }

  beginInjection(): void {
    this.injection = "injecting";
    this.emit();
  }

  resetInjection(): void {
    this.injection = "idle";
    this.emit();
  }

  finishInjection(
    result: "idle" | "confirmed" | "uncertain" | "rejected",
  ): void {
    this.injection = result;
    this.emit();
  }

  retryFollowing(): void {
    if (this.connectionValue !== "connected") return;
    this.attachmentValue = "detached";
    this.initialized = false;
    this.emit();
  }

  apply(change: DesktopTaskChange, generation: number): DesktopChangeResult {
    if (generation !== this.generationValue ||
        this.connectionValue !== "connected") return "ignored";
    if (change._tag === "Snapshot") return this.applySnapshot(change);
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

  private applySnapshot(
    change: Extract<DesktopTaskChange, { readonly _tag: "Snapshot" }>,
  ): DesktopChangeResult {
    if (!validRevision(change.revision)) return this.requestResync();
    if (this.revisionValue != null &&
        (change.revision < this.revisionValue ||
          (this.initialized && change.revision === this.revisionValue))) {
      return "ignored";
    }
    this.revisionValue = change.revision;
    this.clearObservedState();
    for (const entity of change.entities) {
      this.entityTurns.set(entity.key, entity.turn.id);
      this.turns.set(entity.turn.id, entity.turn);
    }
    for (const deliveryId of change.deliveryIds) {
      this.deliveryIds.add(deliveryId);
    }
    this.initialized = true;
    this.attachmentValue = "synchronized";
    this.emit();
    return "applied";
  }

  private applyPatches(
    change: Extract<DesktopTaskChange, { readonly _tag: "Patches" }>,
  ): DesktopChangeResult {
    if (!this.initialized || this.revisionValue == null) {
      return this.requestResync();
    }
    if (!validRevision(change.baseRevision) ||
        !validRevision(change.revision)) return this.requestResync();
    if (change.revision <= this.revisionValue) return "ignored";
    if (change.baseRevision !== this.revisionValue ||
        change.revision <= change.baseRevision) return this.requestResync();
    for (const delta of change.deltas) this.applyDelta(delta);
    for (const deliveryId of change.deliveryIds) {
      this.deliveryIds.add(deliveryId);
    }
    this.revisionValue = change.revision;
    this.emit();
    return "applied";
  }

  private applyDelta(delta: DesktopTurnDelta): void {
    if (delta._tag === "Upsert") {
      this.entityTurns.set(delta.entity.key, delta.entity.turn.id);
      this.turns.set(delta.entity.turn.id, delta.entity.turn);
      return;
    }
    if (delta._tag === "Bind") {
      this.entityTurns.set(delta.key, delta.turnId);
      if (!this.turns.has(delta.turnId)) {
        this.turns.set(delta.turnId, {
          id: delta.turnId,
          status: "inProgress",
          error: null,
        });
      }
      return;
    }
    const turnId = this.entityTurns.get(delta.key);
    const turn = turnId == null ? undefined : this.turns.get(turnId);
    if (delta._tag === "Remove") {
      this.entityTurns.delete(delta.key);
      if (turnId != null) this.turns.delete(turnId);
    } else if (turn != null && delta._tag === "Status") {
      this.turns.set(turn.id, { ...turn, status: delta.status });
    } else if (turn != null && delta._tag === "Error") {
      this.turns.set(turn.id, { ...turn, error: delta.error });
    }
  }

  private requestResync(): DesktopChangeResult {
    this.beginResync();
    return "resync";
  }

  private clearObservedState(): void {
    this.deliveryIds.clear();
    this.entityTurns.clear();
    this.turns.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
