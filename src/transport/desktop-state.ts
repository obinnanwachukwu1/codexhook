import type { Turn } from "./protocol.js";
import { DesktopTimeoutError } from "./desktop-errors.js";
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
  private readonly deliveryTurns = new Map<string, string>();
  private readonly entityTurns = new Map<string, string>();
  private generationValue = 0;
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
    return this.attachmentValue === "synchronized";
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
        : [...this.turns.values()].some(
            (turn) => turn.status === "inProgress",
          ) ? "active" : "idle",
      injection: this.injection,
      generation: this.generationValue,
      revision: this.revisionValue,
      turns: this.turnsSnapshot(),
    };
  }

  activeTurn(): Turn | undefined {
    const active = [...this.turns.values()].filter(
      (turn) => turn.status === "inProgress",
    );
    return active.length === 1 ? active[0] : undefined;
  }

  hasMultipleActiveTurns(): boolean {
    let count = 0;
    for (const turn of this.turns.values()) {
      if (turn.status === "inProgress" && ++count > 1) return true;
    }
    return false;
  }

  turn(turnId: string): Turn | undefined {
    return this.turns.get(turnId);
  }

  hasDelivery(deliveryId: string, turnId?: string): boolean {
    if (!this.deliveryIds.has(deliveryId)) return false;
    return turnId == null || this.deliveryTurns.get(deliveryId) === turnId;
  }

  beginConnecting(): void {
    this.connectionValue = "connecting";
    this.attachmentValue = "detached";
    this.emit();
  }

  beginFollowing(generation: number): void {
    this.connectionValue = "connected";
    this.attachmentValue = "following";
    this.generationValue = generation;
    this.revisionValue = null;
    this.clearObservedState();
    this.emit();
  }

  beginResync(): void {
    this.attachmentValue = "following";
    this.emit();
  }

  disconnected(): void {
    this.connectionValue = "disconnected";
    this.attachmentValue = "detached";
    if (this.injection === "injecting") this.injection = "uncertain";
    this.emit();
  }

  setInjection(result: InjectionState): void {
    this.injection = result;
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
        reject(new DesktopTimeoutError("Desktop thread state timed out"));
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
          (this.ready && change.revision === this.revisionValue))) {
      return "ignored";
    }
    this.revisionValue = change.revision;
    this.clearObservedState();
    for (const entity of change.entities) {
      this.bindTurn(entity.key, entity.turn);
    }
    for (const deliveryId of change.deliveryIds) {
      this.deliveryIds.add(deliveryId);
    }
    this.bindDeliveries(change.deliveryBindings ?? []);
    this.attachmentValue = "synchronized";
    this.emit();
    return "applied";
  }

  private applyPatches(
    change: Extract<DesktopTaskChange, { readonly _tag: "Patches" }>,
  ): DesktopChangeResult {
    if (!this.ready || this.revisionValue == null) {
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
    this.bindDeliveries(change.deliveryBindings ?? []);
    this.revisionValue = change.revision;
    this.emit();
    return "applied";
  }

  private applyDelta(delta: DesktopTurnDelta): void {
    if (delta._tag === "Upsert") {
      this.bindTurn(delta.entity.key, delta.entity.turn);
      return;
    }
    if (delta._tag === "Bind") {
      this.bindTurn(delta.key, this.turns.get(delta.turnId) ?? {
        id: delta.turnId,
        status: "inProgress",
        error: null,
      });
      return;
    }
    const turnId = this.entityTurns.get(delta.key);
    const turn = turnId == null ? undefined : this.turns.get(turnId);
    if (delta._tag === "Remove") {
      this.entityTurns.delete(delta.key);
      if (turnId != null &&
          ![...this.entityTurns.values()].includes(turnId)) {
        this.turns.delete(turnId);
        this.dropTurnDeliveries(turnId);
      }
    } else if (turn != null && delta._tag === "Status") {
      this.turns.set(turn.id, { ...turn, status: delta.status });
    } else if (turn != null && delta._tag === "Error") {
      this.turns.set(turn.id, { ...turn, error: delta.error });
    }
  }

  private bindTurn(key: string, turn: Turn): void {
    const previous = this.entityTurns.get(key);
    this.entityTurns.set(key, turn.id);
    if (previous != null && previous !== turn.id &&
        ![...this.entityTurns.values()].includes(previous)) {
      this.turns.delete(previous);
      this.dropTurnDeliveries(previous);
    }
    this.turns.set(turn.id, turn);
  }

  private requestResync(): DesktopChangeResult {
    this.beginResync();
    return "resync";
  }

  private clearObservedState(): void {
    this.deliveryIds.clear();
    this.deliveryTurns.clear();
    this.entityTurns.clear();
    this.turns.clear();
  }

  private bindDeliveries(
    bindings: ReadonlyArray<{ readonly key: string; readonly deliveryId: string }>,
  ): void {
    for (const binding of bindings) {
      const turnId = this.entityTurns.get(binding.key);
      if (turnId != null) this.deliveryTurns.set(binding.deliveryId, turnId);
    }
  }

  private dropTurnDeliveries(turnId: string): void {
    for (const [deliveryId, observedTurnId] of this.deliveryTurns) {
      if (observedTurnId === turnId) this.deliveryTurns.delete(deliveryId);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
