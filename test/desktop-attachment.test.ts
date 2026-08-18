import assert from "node:assert/strict";
import test from "node:test";
import { DesktopAttachment } from "../src/transport/desktop-attachment.js";
import type {
  DesktopTaskChange,
  DesktopCommand,
  DesktopCommandReply,
  DesktopTaskProtocol,
} from "../src/transport/desktop-protocol.js";

type ChangeListener = (threadId: string, change: DesktopTaskChange) => void;

class FakeDesktopProtocol implements DesktopTaskProtocol {
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

function startPatch(
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

function startCommand(id = "delivery-1"): DesktopCommand {
  return {
    kind: "start",
    threadId: "thread-1",
    clientUserMessageId: id,
    input: [{ type: "text", text: "hello" }],
  };
}

test("confirms a start only after fenced Desktop state observes it", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  protocol.injectBehavior = async () => {
    protocol.emit("thread-1", startPatch(1, "turn-1"));
    return { _tag: "Accepted", result: { turn: { id: "turn-1" } } };
  };
  const attachment = new DesktopAttachment(
    async () => protocol,
    protocol,
    { proofTimeoutMs: 50 },
  );

  const result = await attachment.inject(startCommand());
  assert.equal(result._tag, "Confirmed");
  if (result._tag !== "Confirmed") return;
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.state.activity, "active");
  assert.equal(result.state.injection, "confirmed");
});

test("serializes commands per task and rejects a racing second start", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  protocol.injectBehavior = async () => {
    enter();
    await gate;
    protocol.emit("thread-1", startPatch(1, "turn-1"));
    return { _tag: "Accepted", result: { turnId: "turn-1" } };
  };
  const attachment = new DesktopAttachment(async () => protocol, protocol);

  const first = attachment.inject(startCommand("delivery-1"));
  await entered;
  const second = attachment.inject(startCommand("delivery-2"));
  assert.equal(protocol.injections.length, 1);
  release();
  assert.equal((await first)._tag, "Confirmed");
  assert.equal((await second)._tag, "NotSubmitted");
  assert.equal(protocol.injections.length, 1);
});

test("validates the synchronized active turn before steering", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 4, {
    active: { turnId: "turn-current", status: "inProgress", error: null },
  });
  const attachment = new DesktopAttachment(async () => protocol, protocol);
  await attachment.resume("thread-1");
  const result = await attachment.inject({
    kind: "steer",
    threadId: "thread-1",
    expectedTurnId: "turn-stale",
    clientUserMessageId: "delivery-2",
    input: [],
  });
  assert.equal(result._tag, "NotSubmitted");
  assert.equal(protocol.injections.length, 0);
});

test("proves steer by delivery identity and interrupt by terminal state", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 4, {
    active: { turnId: "turn-current", status: "inProgress", error: null },
  });
  protocol.injectBehavior = async (command) => {
    protocol.emit("thread-1", {
      _tag: "Patches",
      baseRevision: command.kind === "steer" ? 4 : 5,
      revision: command.kind === "steer" ? 5 : 6,
      deltas: command.kind === "interrupt" ? [{
        _tag: "Status",
        key: "active",
        status: "interrupted",
      }] : [],
      deliveryIds: command.kind === "steer" ? ["delivery-2"] : [],
    });
    return { _tag: "Accepted", result: {} };
  };
  const attachment = new DesktopAttachment(async () => protocol, protocol);
  const steered = await attachment.inject({
    kind: "steer",
    threadId: "thread-1",
    expectedTurnId: "turn-current",
    clientUserMessageId: "delivery-2",
    input: [],
  });
  assert.equal(steered._tag, "Confirmed");
  const interrupted = await attachment.inject({
    kind: "interrupt",
    threadId: "thread-1",
    expectedTurnId: "turn-current",
  });
  assert.equal(interrupted._tag, "Confirmed");
  if (interrupted._tag === "Confirmed") {
    assert.equal(interrupted.turn.status, "interrupted");
  }
});

test("does not confirm steer from an unrelated revision", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 4, {
    active: { turnId: "turn-current", status: "inProgress", error: null },
  });
  protocol.injectBehavior = async () => {
    protocol.emit("thread-1", {
      _tag: "Patches",
      baseRevision: 4,
      revision: 5,
      deltas: [],
      deliveryIds: [],
    });
    return { _tag: "Accepted", result: {} };
  };
  const attachment = new DesktopAttachment(
    async () => protocol,
    protocol,
    { proofTimeoutMs: 5 },
  );
  const result = await attachment.inject({
    kind: "steer",
    threadId: "thread-1",
    expectedTurnId: "turn-current",
    clientUserMessageId: "delivery-2",
    input: [],
  });
  assert.equal(result._tag, "Ambiguous");
});

test("reports disconnect during injection as ambiguous", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  protocol.injectBehavior = async () => {
    protocol.disconnect();
    throw new Error("closed after write");
  };
  const attachment = new DesktopAttachment(async () => protocol, protocol);
  const result = await attachment.inject(startCommand());
  assert.equal(result._tag, "Ambiguous");
  assert.equal(result.state.connection, "disconnected");
});

test("drops a failed follow so the next operation can reconnect", async () => {
  const first = new FakeDesktopProtocol();
  first.followBehavior = async () => { throw new Error("follow failed"); };
  const second = new FakeDesktopProtocol();
  second.setSnapshot("thread-1", 4);
  const attachment = new DesktopAttachment(async () => second, first);
  await assert.rejects(attachment.resume("thread-1"), /follow failed/);
  assert.deepEqual(await attachment.resume("thread-1"), []);
  assert.deepEqual(second.follows, ["thread-1"]);
});

test("retries history after a transient resync failure", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 2);
  let attempts = 0;
  protocol.historyBehavior = async (threadId) => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    protocol.emit(threadId, {
      _tag: "Snapshot",
      revision: 8,
      entities: [],
      deliveryIds: [],
    });
  };
  const attachment = new DesktopAttachment(async () => protocol, protocol);
  await attachment.resume("thread-1");
  const gap: DesktopTaskChange = {
    _tag: "Patches",
    baseRevision: 6,
    revision: 7,
    deltas: [],
    deliveryIds: [],
  };
  protocol.emit("thread-1", gap);
  await new Promise((resolve) => setImmediate(resolve));
  protocol.emit("thread-1", gap);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(protocol.historyRequests.length, 2);
  assert.equal(attachment.state("thread-1").revision, 8);
});

test("reconnects, restores subscriptions, and ignores stale events", async () => {
  const first = new FakeDesktopProtocol();
  first.setSnapshot("thread-1", 1);
  first.setSnapshot("thread-2", 1);
  const second = new FakeDesktopProtocol();
  second.setSnapshot("thread-1", 10);
  second.setSnapshot("thread-2", 11);
  const attachment = new DesktopAttachment(async () => second, first);
  await attachment.resume("thread-1");
  await attachment.resume("thread-2");
  first.disconnect();
  await attachment.resume("thread-1");
  first.emit("thread-1", {
    _tag: "Snapshot",
    revision: 99,
    entities: [],
    deliveryIds: [],
  });
  assert.deepEqual(second.follows.sort(), ["thread-1", "thread-2"]);
  assert.equal(attachment.state("thread-1").revision, 10);
  assert.equal(attachment.state("thread-2").revision, 11);
});

test("closes a protocol that connects after attachment shutdown", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  let startConnect: () => void = () => undefined;
  let finishConnect: () => void = () => undefined;
  const connecting = new Promise<void>((resolve) => { startConnect = resolve; });
  const gate = new Promise<void>((resolve) => { finishConnect = resolve; });
  const attachment = new DesktopAttachment(async () => {
    startConnect();
    await gate;
    return protocol;
  });
  const resume = attachment.resume("thread-1");
  await connecting;
  attachment.close();
  finishConnect();
  await assert.rejects(resume, /closed/);
  assert.equal(protocol.connected, false);
});
