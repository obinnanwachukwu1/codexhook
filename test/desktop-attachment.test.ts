import assert from "node:assert/strict";
import test from "node:test";
import { DesktopAttachment } from "../src/transport/desktop-attachment.js";
import type { DesktopTaskChange } from "../src/transport/desktop-task-protocol.js";
import {
  FakeDesktopProtocol,
  startCommand,
  startPatch,
} from "./support/desktop-protocol-fixture.js";

test("confirms a start only after fenced Desktop state observes it", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  protocol.injectBehavior = async () => {
    protocol.emit("thread-1", startPatch(1, "turn-1"));
    return {
      _tag: "Accepted",
      result: { turn: { id: "turn-1" } },
      turnId: "turn-1",
    };
  };
  const attachment = new DesktopAttachment(
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
    return {
      _tag: "Accepted",
      result: { turnId: "turn-1" },
      turnId: "turn-1",
    };
  };
  const attachment = new DesktopAttachment(protocol);

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
  const attachment = new DesktopAttachment(protocol);
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

test("proves steer by delivery identity on the expected turn", async () => {
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
      deliveryIds: ["delivery-2"],
      deliveryBindings: [{ key: "active", deliveryId: "delivery-2" }],
    });
    return { _tag: "Accepted", result: {}, turnId: null };
  };
  const attachment = new DesktopAttachment(protocol);
  const steered = await attachment.inject({
    kind: "steer",
    threadId: "thread-1",
    expectedTurnId: "turn-current",
    clientUserMessageId: "delivery-2",
    input: [],
  });
  assert.equal(steered._tag, "Confirmed");
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
    return { _tag: "Accepted", result: {}, turnId: null };
  };
  const attachment = new DesktopAttachment(
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
  const attachment = new DesktopAttachment(protocol);
  const result = await attachment.inject(startCommand());
  assert.equal(result._tag, "Ambiguous");
  assert.equal(result.state.connection, "disconnected");
});

test("does not prove an injection from a replacement generation", async () => {
  const protocol = new FakeDesktopProtocol();
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const injecting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  protocol.setSnapshot("thread-1", 10);
  protocol.setSnapshot("thread-2", 1);
  protocol.injectBehavior = async () => {
    entered();
    await gate;
    return { _tag: "Accepted", result: {}, turnId: "turn-1" };
  };
  const attachment = new DesktopAttachment(
    protocol,
    { proofTimeoutMs: 5 },
  );
  const pending = attachment.inject(startCommand());
  await injecting;
  protocol.disconnect();
  protocol.setSnapshot("thread-1", 50, {
    active: { turnId: "turn-1", status: "inProgress", error: null },
  });
  protocol.reconnect();
  protocol.emit("thread-1", {
    _tag: "Snapshot",
    revision: 50,
    entities: [{
      key: "active",
      turn: { id: "turn-1", status: "inProgress", error: null },
    }],
    deliveryIds: [],
  });
  await attachment.resume("thread-2");
  release();

  const result = await pending;
  assert.equal(result._tag, "Ambiguous");
  assert.equal(result.state.generation, 2);
});

test("drops a failed follow so the next operation can reconnect", async () => {
  const protocol = new FakeDesktopProtocol();
  let attempts = 0;
  protocol.setSnapshot("thread-1", 4);
  protocol.followBehavior = async () => {
    if (++attempts === 1) throw new Error("follow failed");
  };
  const attachment = new DesktopAttachment(protocol);
  await assert.rejects(attachment.resume("thread-1"), /follow failed/);
  assert.deepEqual(await attachment.resume("thread-1"), []);
  assert.deepEqual(protocol.follows, ["thread-1", "thread-1"]);
  assert.deepEqual(protocol.historyRequests, []);
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
    return true;
  };
  const attachment = new DesktopAttachment(protocol);
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

test("retries history after a resync completes without a snapshot", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 2);
  const attachment = new DesktopAttachment(
    protocol,
    { followTimeoutMs: 5 },
  );
  await attachment.resume("thread-1");
  protocol.emitHistorySnapshots = false;
  protocol.emit("thread-1", {
    _tag: "Patches",
    baseRevision: 6,
    revision: 7,
    deltas: [],
    deliveryIds: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(attachment.resume("thread-1"), /timed out/);
  protocol.emitHistorySnapshots = true;
  assert.deepEqual(await attachment.resume("thread-1"), []);
  assert.deepEqual(protocol.follows, ["thread-1"]);
  assert.equal(protocol.historyRequests.length, 3);
});

test("reconnects, restores subscriptions, and ignores stale events", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  protocol.setSnapshot("thread-2", 1);
  const attachment = new DesktopAttachment(protocol);
  await attachment.resume("thread-1");
  await attachment.resume("thread-2");
  protocol.disconnect();
  protocol.setSnapshot("thread-1", 10);
  protocol.setSnapshot("thread-2", 11);
  protocol.reconnect();
  protocol.emit("thread-1", {
    _tag: "Snapshot",
    revision: 10,
    entities: [],
    deliveryIds: [],
  });
  protocol.emit("thread-2", {
    _tag: "Snapshot",
    revision: 11,
    entities: [],
    deliveryIds: [],
  });
  await attachment.resume("thread-1");
  protocol.emit("thread-1", {
    _tag: "Snapshot",
    revision: 9,
    entities: [],
    deliveryIds: [],
  });
  assert.deepEqual(protocol.follows.sort(), ["thread-1", "thread-2"]);
  assert.equal(attachment.state("thread-1").revision, 10);
  assert.equal(attachment.state("thread-2").revision, 11);
});

test("does not demote another followed task during reconnect", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  protocol.setSnapshot("thread-2", 1);
  const attachment = new DesktopAttachment(protocol);
  await attachment.resume("thread-1");
  await attachment.resume("thread-2");

  protocol.disconnect();
  protocol.setSnapshot("thread-2", 10, {
    active: { turnId: "turn-2", status: "inProgress", error: null },
  });
  protocol.beginReconnect();
  const resumed = attachment.resume("thread-2");
  protocol.finishReconnect();

  assert.deepEqual(await resumed, [{
    id: "turn-2",
    status: "inProgress",
    error: null,
  }]);
  assert.equal(attachment.state("thread-2").generation, 2);
  assert.equal(attachment.state("thread-2").attachment, "synchronized");
});

test("close fences a reconnect while subscriptions are restoring", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  let following: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { following = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  protocol.historyBehavior = async () => {
    following();
    await gate;
    return true;
  };
  const attachment = new DesktopAttachment(protocol);
  await attachment.resume("thread-1");
  protocol.disconnect();
  protocol.reconnect();
  const resume = attachment.resume("thread-1");
  await entered;

  attachment.close();
  release();

  await assert.rejects(resume, /closed/);
  assert.equal(attachment.state("thread-1").connection, "disconnected");
  assert.equal(protocol.connected, false);
});

test("close detaches listeners and leaves followed state disconnected", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1);
  const attachment = new DesktopAttachment(protocol);
  await attachment.resume("thread-1");

  attachment.close();
  protocol.emit("thread-1", {
    _tag: "Snapshot",
    revision: 99,
    entities: [],
    deliveryIds: [],
  });

  assert.equal(attachment.state("thread-1").connection, "disconnected");
  assert.equal(attachment.state("thread-1").revision, 1);
});
