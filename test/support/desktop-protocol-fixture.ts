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
  private readonly changes = new Set<ChangeListener>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private readonly snapshots = new Map<string, DesktopTaskChange>();
  injectBehavior: (
    command: DesktopCommand,
  ) => Promise<DesktopCommandReply> = async () => ({
    _tag: "Rejected",
    reason: "not configured",
    notWritten: true,
  });
  followBehavior: (threadId: string) => Promise<void> = async () => undefined;
  historyBehavior: (threadId: string) => Promise<void> = async () => undefined;

  setSnapshot(
    threadId: string,
    revision: number,
    turns: Record<string, {
      turnId: string;
      status: "inProgress" | "completed" | "interrupted" | "failed";
      error: null;
    }> = {},
  ): void {
    this.snapshots.set(threadId, {
      _tag: "Snapshot",
      revision,
      entities: Object.entries(turns).map(([key, turn]) => ({
        key,
        turn: { id: turn.turnId, status: turn.status, error: turn.error },
      })),
      deliveryIds: [],
    });
  }

  emit(threadId: string, change: DesktopTaskChange): void {
    for (const listener of this.changes) listener(threadId, change);
  }

  disconnect(): void {
    this.connected = false;
    for (const listener of this.disconnects) {
      listener(new Error("test disconnect"));
    }
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

  async loadHistory(threadId: string): Promise<void> {
    this.historyRequests.push(threadId);
    await this.historyBehavior(threadId);
  }

  onChange(listener: ChangeListener): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
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
