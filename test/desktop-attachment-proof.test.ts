import assert from "node:assert/strict";
import test from "node:test";
import { DesktopAttachment } from "../src/transport/desktop-attachment.js";
import {
  FakeDesktopProtocol,
  startCommand,
  startPatch,
} from "./support/desktop-protocol-fixture.js";

test("does not prove start from a turn present at the baseline", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1, {
    old: { turnId: "turn-old", status: "completed", error: null },
  });
  protocol.injectBehavior = async () => {
    protocol.emit("thread-1", startPatch(1, "turn-new"));
    return { _tag: "Accepted", result: {}, turnId: "turn-old" };
  };
  const attachment = new DesktopAttachment(
    protocol,
    { proofTimeoutMs: 5 },
  );

  assert.equal((await attachment.inject(startCommand()))._tag, "Ambiguous");
});

test("does not prove steer from a delivery present at the baseline", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 4, {
    active: { turnId: "turn-1", status: "inProgress", error: null },
  }, ["delivery-1"]);
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
    expectedTurnId: "turn-1",
    clientUserMessageId: "delivery-1",
    input: [],
    createdAt: 1,
  });
  assert.equal(result._tag, "Ambiguous");
});

test("returns terminal turn evidence retained across disconnect", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 1, {
    active: { turnId: "turn-1", status: "inProgress", error: null },
  });
  const attachment = new DesktopAttachment(protocol);
  await attachment.resume("thread-1");
  protocol.emit("thread-1", {
    _tag: "Patches",
    baseRevision: 1,
    revision: 2,
    deltas: [{ _tag: "Status", key: "active", status: "completed" }],
    deliveryIds: [],
  });
  protocol.disconnect();

  assert.deepEqual(await attachment.awaitTurn("thread-1", "turn-1", 5), {
    id: "turn-1",
    status: "completed",
    error: null,
  });
});

test("does not prove steer from a delivery on another turn", async () => {
  const protocol = new FakeDesktopProtocol();
  protocol.setSnapshot("thread-1", 4, {
    active: { turnId: "turn-current", status: "inProgress", error: null },
  });
  protocol.injectBehavior = async () => {
    protocol.emit("thread-1", {
      _tag: "Patches",
      baseRevision: 4,
      revision: 5,
      deltas: [{
        _tag: "Upsert",
        entity: {
          key: "other",
          turn: { id: "turn-other", status: "completed", error: null },
        },
      }],
      deliveryIds: ["delivery-2"],
      deliveryBindings: [{ key: "other", deliveryId: "delivery-2" }],
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
    createdAt: 2,
  });
  assert.equal(result._tag, "Ambiguous");
});
