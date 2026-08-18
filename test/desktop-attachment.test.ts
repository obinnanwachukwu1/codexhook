import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopAttachment,
  DesktopNotWrittenError,
  DesktopUncertainError,
} from "../src/transport/desktop-attachment.js";
import type {
  DesktopChange,
  DesktopCommand,
  DesktopCommandReply,
  DesktopProtocol,
} from "../src/transport/desktop-protocol.js";

type ChangeListener = (threadId: string, change: DesktopChange) => void;

class FakeDesktopProtocol implements DesktopProtocol {
  connected = true;
  readonly follows: string[] = [];
  readonly historyRequests: string[] = [];
  readonly injections: DesktopCommand[] = [];
  private readonly changes = new Set<ChangeListener>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private readonly snapshots = new Map<string, DesktopChange>();
  injectBehavior: (
    command: DesktopCommand,
  ) => Promise<DesktopCommandReply> = async () => ({
    _tag: "Rejected",
    reason: "not configured",
    retrySafe: true,
  });
  historyBehavior: (threadId: string) => Promise<void> = async () => undefined;

  setSnapshot(
    threadId: string,
    revision: number,
    turns: Record<string, unknown> = {},
  ): void {
    this.snapshots.set(threadId, {
      type: "snapshot",
      revision,
      conversationState: {
        turnHistory: { history: { entitiesByKey: turns } },
      },
    });
  }

  emit(threadId: string, change: DesktopChange): void {
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

function startPatch(baseRevision: number, turnId: string): DesktopChange {
  return {
    type: "patches",
    baseRevision,
    revision: baseRevision + 1,
    patches: [{
      op: "add",
      path: ["turnHistory", "history", "entitiesByKey", turnId],
      value: { turnId, status: "inProgress", error: null },
    }],
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
    queueMicrotask(() => protocol.emit("thread-1", startPatch(1, "turn-1")));
    return {
      _tag: "Accepted",
      result: { turn: { id: "turn-1" } },
    };
  };
  const attachment = new DesktopAttachment(
    async () => protocol,
    protocol,
    { proofTimeoutMs: 50 },
  );

  const result = await attachment.inject(startCommand());
  assert.equal(result.evidence, "confirmed");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.state.attachment, "synchronized");
  assert.equal(result.state.activity, "active");
  assert.equal(result.state.injection, "confirmed");
});

test("serializes commands per task and rejects a racing second start", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  protocol.injectBehavior = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    protocol.emit("thread-1", startPatch(1, "turn-1"));
    return { _tag: "Accepted", result: { turnId: "turn-1" } };
  };
  const attachment = new DesktopAttachment(
    async () => protocol,
    protocol,
    { proofTimeoutMs: 50 },
  );

  const [first, second] = await Promise.allSettled([
    attachment.inject(startCommand("delivery-1")),
    attachment.inject(startCommand("delivery-2")),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  if (second.status === "rejected") {
    assert.equal(second.reason instanceof DesktopNotWrittenError, true);
  }
  assert.equal(protocol.injections.length, 1);
});

test("validates the synchronized active turn before steering", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 4, {
    active: { turnId: "turn-current", status: "inProgress", error: null },
  });
  const attachment = new DesktopAttachment(async () => protocol, protocol);
  await attachment.resume("thread-1");

  await assert.rejects(
    attachment.inject({
      kind: "steer",
      threadId: "thread-1",
      expectedTurnId: "turn-stale",
      input: [],
    }),
    DesktopNotWrittenError,
  );
  assert.equal(protocol.injections.length, 0);
});

test("confirms steer and interrupt against post-command state", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 4, {
    active: { turnId: "turn-current", status: "inProgress", error: null },
  });
  protocol.injectBehavior = async (command) => {
    protocol.emit("thread-1", {
      type: "patches",
      baseRevision: command.kind === "steer" ? 4 : 5,
      revision: command.kind === "steer" ? 5 : 6,
      patches: command.kind === "interrupt" ? [{
        op: "replace",
        path: [
          "turnHistory", "history", "entitiesByKey", "active", "status",
        ],
        value: "interrupted",
      }] : [{
        op: "add",
        path: ["turnHistory", "history", "lastSteerId"],
        value: "delivery-2",
      }],
    });
    return { _tag: "Accepted", result: {} };
  };
  const attachment = new DesktopAttachment(
    async () => protocol,
    protocol,
    { proofTimeoutMs: 50 },
  );

  const steered = await attachment.inject({
    kind: "steer",
    threadId: "thread-1",
    expectedTurnId: "turn-current",
    clientUserMessageId: "delivery-2",
    input: [],
  });
  assert.equal(steered.state.revision, 5);
  const interrupted = await attachment.inject({
    kind: "interrupt",
    threadId: "thread-1",
    expectedTurnId: "turn-current",
  });
  assert.equal(interrupted.turn?.status, "interrupted");
  assert.equal(interrupted.state.revision, 6);
});

test("marks an accepted write uncertain when state cannot prove it", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  protocol.injectBehavior = async () => ({
    _tag: "Accepted",
    result: { turnId: "turn-unproven" },
  });
  const attachment = new DesktopAttachment(
    async () => protocol,
    protocol,
    { proofTimeoutMs: 10 },
  );

  await assert.rejects(
    attachment.inject(startCommand()),
    DesktopUncertainError,
  );
  assert.equal(attachment.state("thread-1").injection, "uncertain");
});

test("requests complete history on a revision gap", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 2);
  protocol.historyBehavior = async (threadId) => {
    protocol.emit(threadId, {
      type: "snapshot",
      revision: 8,
      conversationState: {
        turnHistory: { history: { entitiesByKey: {} } },
      },
    });
  };
  const attachment = new DesktopAttachment(async () => protocol, protocol);
  await attachment.resume("thread-1");
  protocol.emit("thread-1", {
    type: "patches",
    baseRevision: 6,
    revision: 7,
    patches: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(protocol.historyRequests, ["thread-1"]);
  assert.equal(attachment.state("thread-1").revision, 8);
  assert.equal(attachment.state("thread-1").attachment, "synchronized");
});

test("reconnects and restores every task subscription", async () => {
  const first = new FakeDesktopProtocol();
  first.setSnapshot("thread-1", 1);
  first.setSnapshot("thread-2", 1);
  const second = new FakeDesktopProtocol();
  second.setSnapshot("thread-1", 10);
  second.setSnapshot("thread-2", 11);
  let connects = 0;
  const attachment = new DesktopAttachment(
    async () => {
      connects += 1;
      return second;
    },
    first,
  );
  await attachment.resume("thread-1");
  await attachment.resume("thread-2");
  first.disconnect();

  await attachment.resume("thread-1");
  assert.equal(connects, 1);
  assert.deepEqual(second.follows.sort(), ["thread-1", "thread-2"]);
  assert.equal(attachment.state("thread-1").revision, 10);
  assert.equal(attachment.state("thread-2").revision, 11);
});
