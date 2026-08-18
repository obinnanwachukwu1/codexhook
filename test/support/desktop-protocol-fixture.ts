import type {
  DesktopTaskChange,
  DesktopCommand,
  DesktopCommandReply,
  DesktopTaskProtocol,
} from "../../src/transport/desktop-task-protocol.js";

type ChangeListener = (threadId: string, change: DesktopTaskChange) => void;

export class FakeDesktopProtocol implements DesktopTaskProtocol {
  connected = true;
  readonly follows: string[] = [];
  readonly historyRequests: string[] = [];
  readonly injections: DesktopCommand[] = [];
  emitHistorySnapshots = true;
  private readonly changes = new Set<ChangeListener>();
  private readonly connections = new Set<
    (event: "Disconnected" | "Reconnected" | "Reconnecting") => void
  >();
  private readonly snapshots = new Map<string, DesktopTaskChange>();
  injectBehavior: (
    command: DesktopCommand,
  ) => Promise<DesktopCommandReply> = async () => ({
    _tag: "Rejected",
    reason: "not configured",
    notWritten: true,
  });
  followBehavior: (threadId: string) => Promise<void> = async () => undefined;
  historyBehavior: (threadId: string) => Promise<boolean> = async () => true;

  setSnapshot(
    threadId: string,
    revision: number,
    turns: Record<string, {
      turnId: string;
      status: "inProgress" | "completed" | "interrupted" | "failed";
      error: null;
    }> = {},
    deliveryIds: ReadonlyArray<string> = [],
  ): void {
    const deliveryKey = Object.entries(turns).find(
      ([, turn]) => turn.status === "inProgress",
    )?.[0] ?? Object.keys(turns)[0];
    this.snapshots.set(threadId, {
      _tag: "Snapshot",
      revision,
      entities: Object.entries(turns).map(([key, turn]) => ({
        key,
        turn: { id: turn.turnId, status: turn.status, error: turn.error },
      })),
      deliveryIds,
      deliveryBindings: deliveryKey == null
        ? []
        : deliveryIds.map((deliveryId) => ({
            key: deliveryKey,
            deliveryId,
          })),
    });
  }

  emit(threadId: string, change: DesktopTaskChange): void {
    for (const listener of this.changes) listener(threadId, change);
  }

  disconnect(): void {
    this.connected = false;
    for (const listener of this.connections) listener("Disconnected");
  }

  reconnect(): void {
    for (const listener of this.connections) listener("Reconnecting");
    this.connected = true;
    for (const listener of this.connections) listener("Reconnected");
  }

  close(): void {
    this.disconnect();
  }

  async follow(threadId: string): Promise<void> {
    this.follows.push(threadId);
    await this.followBehavior(threadId);
    const snapshot = this.snapshots.get(threadId);
    if (snapshot != null) this.emit(threadId, snapshot);
  }

  async inject(command: DesktopCommand): Promise<DesktopCommandReply> {
    this.injections.push(command);
    return this.injectBehavior(command);
  }

  async loadHistory(threadId: string): Promise<boolean> {
    this.historyRequests.push(threadId);
    const accepted = await this.historyBehavior(threadId);
    const snapshot = this.snapshots.get(threadId);
    if (accepted && this.emitHistorySnapshots && snapshot != null) {
      this.emit(threadId, snapshot);
    }
    return accepted;
  }

  onChange(listener: ChangeListener): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  onConnection(
    listener: (event: "Disconnected" | "Reconnected" | "Reconnecting") => void,
  ): () => void {
    this.connections.add(listener);
    return () => this.connections.delete(listener);
  }
}

export function startPatch(
  baseRevision: number,
  turnId: string,
  deliveryIds: ReadonlyArray<string> = [],
): DesktopTaskChange {
  return {
    _tag: "Patches",
    baseRevision,
    revision: baseRevision + 1,
    deltas: [{
      _tag: "Upsert",
      entity: {
        key: turnId,
        turn: { id: turnId, status: "inProgress", error: null },
      },
    }],
    deliveryIds,
    deliveryBindings: deliveryIds.map((deliveryId) => ({
      key: turnId,
      deliveryId,
    })),
  };
}

export function startCommand(id = "delivery-1"): DesktopCommand {
  return {
    kind: "start",
    threadId: "thread-1",
    clientUserMessageId: id,
    input: [{ type: "text", text: "hello" }],
  };
}
