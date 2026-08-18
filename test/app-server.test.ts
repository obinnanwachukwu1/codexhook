import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { CanonicalAppServerClient } from "../src/app-server/client.js";
import { CanonicalQueryFailure } from "../src/app-server/errors.js";
import {
  canonicalThread as thread,
  canonicalTurn as turn,
  fakeAppServerPeer as fakePeer,
} from "./support/app-server-fixture.js";

test("lists every local source across active and archived pages", async () => {
  const fixture = fakePeer((method, raw) => {
    assert.equal(method, "thread/list");
    const params = raw as { archived: boolean; cursor: string | null; sourceKinds: string[] };
    assert.equal(params.sourceKinds.includes("cli"), true);
    assert.equal(params.sourceKinds.includes("vscode"), true);
    assert.equal(params.sourceKinds.includes("exec"), true);
    assert.equal(params.sourceKinds.includes("appServer"), true);
    if (params.archived) {
      return {
        data: [
          thread("archived", { custom: "desktop" }, 2),
          thread("cli", "cli", 1),
        ],
        nextCursor: null,
      };
    }
    if (params.cursor == null) {
      return { data: [thread("cli", "cli", 3)], nextCursor: "next" };
    }
    return { data: [thread("vscode", "vscode", 4)], nextCursor: null };
  });
  const tasks = await Effect.runPromise(
    new CanonicalAppServerClient(fixture.peer).listTasks(),
  );
  assert.deepEqual(tasks.map((task) => task.thread.id), [
    "vscode",
    "cli",
    "archived",
  ]);
  assert.equal(tasks[0]?.provenance.status, "known");
  assert.deepEqual(tasks[2]?.provenance, {
    status: "known",
    origin: "desktop",
  });
  assert.equal(fixture.requests.length, 3);
});

test("reports generated app-server and subagent provenance without raw payloads", async () => {
  const sources = [
    thread("app", "appServer", 4),
    thread("subagent", { subAgent: { threadId: "private" } }, 3),
    thread("missing", undefined, 2),
    thread("internal", { internal: { private: true } }, 1),
  ];
  const fixture = fakePeer((_method, raw) => ({
    data: (raw as { archived: boolean }).archived ? [] : sources,
    nextCursor: null,
  }));
  const tasks = await Effect.runPromise(
    new CanonicalAppServerClient(fixture.peer).listTasks(),
  );
  assert.deepEqual(tasks.map((task) => task.provenance), [
    { status: "known", origin: "app-server" },
    { status: "known", origin: "subagent" },
    { status: "unavailable" },
    { status: "unknown", kind: "internal" },
  ]);
});

test("rejects repeated pagination cursors", async () => {
  const fixture = fakePeer(() => ({ data: [], nextCursor: "same" }));
  const failure = await Effect.runPromise(Effect.flip(
    new CanonicalAppServerClient(fixture.peer).listTasks(),
  ));
  assert.equal(failure instanceof CanonicalQueryFailure, true);
  assert.equal(failure.code, "pagination");
});

test("accepts schema-valid omitted cursors and full-item defaults", async () => {
  const fixture = fakePeer((method, raw) => {
    if (method === "thread/list") {
      return {
        data: (raw as { archived: boolean }).archived
          ? []
          : [thread("task-1", "cli")],
      };
    }
    if (method === "thread/read") {
      return { thread: thread("task-1", "cli") };
    }
    return {
      data: [{
        id: "turn-1",
        items: [],
        status: "completed",
        error: null,
      }],
    };
  });
  const client = new CanonicalAppServerClient(fixture.peer);
  const tasks = await Effect.runPromise(client.listTasks());
  const history = await Effect.runPromise(client.readTaskHistory("task-1"));
  assert.deepEqual(tasks.map((task) => task.thread.id), ["task-1"]);
  assert.equal(history.thread.turns[0]?.itemsView, "full");
});

test("bounds pagination even when every cursor is unique", async () => {
  let page = 0;
  const fixture = fakePeer(() => ({
    data: [],
    nextCursor: `page-${++page}`,
  }));
  const failure = await Effect.runPromise(Effect.flip(
    new CanonicalAppServerClient(fixture.peer).listTasks(),
  ));
  assert.equal(failure.code, "pagination");
  assert.equal(fixture.requests.length <= 2_000, true);
});

test("hydrates complete full-detail history and verifies client ids", async () => {
  const fixture = fakePeer((method, raw) => {
    if (method === "thread/read") {
      return { thread: thread("task-1", "cli") };
    }
    const params = raw as { cursor: string | null; itemsView: string };
    assert.equal(params.itemsView, "full");
    return params.cursor == null
      ? { data: [turn("turn-1")], nextCursor: "page-2" }
      : {
          data: [turn("turn-2", [{
            type: "userMessage",
            id: "item-1",
            clientId: "delivery-1",
            content: [],
          }])],
          nextCursor: null,
        };
  });
  const client = new CanonicalAppServerClient(fixture.peer);
  const history = await Effect.runPromise(client.readTaskHistory("task-1"));
  assert.deepEqual(history.thread.turns.map((item) => item.id), ["turn-1", "turn-2"]);
  const verified = await Effect.runPromise(
    client.verifyClientMessage("task-1", "delivery-1"),
  );
  assert.equal(verified.status, "confirmed");
  const existingTurn = await Effect.runPromise(
    client.verifyTurn("task-1", "turn-2"),
  );
  const absentTurn = await Effect.runPromise(
    client.verifyTurn("task-1", "turn-missing"),
  );
  assert.equal(existingTurn.status, "confirmed");
  assert.deepEqual(absentTurn, { status: "absent" });
});

test("projects canonical notifications and scopes their lifetime", async () => {
  const fixture = fakePeer(() => ({}));
  const client = new CanonicalAppServerClient(fixture.peer);
  const events: unknown[] = [];
  await Effect.runPromise(Effect.scoped(
    client.subscribe((event) => events.push(event)).pipe(
      Effect.zipRight(Effect.sync(() => {
        fixture.emit({
          method: "turn/started",
          params: { threadId: "task-1" },
        });
      })),
      Effect.zipRight(Effect.promise(tick)),
    ),
  ));
  fixture.emit({ method: "turn/completed", params: { threadId: "task-1" } });
  await tick();
  assert.deepEqual(events, [{
    type: "event",
    method: "turn/started",
    threadId: "task-1",
    turnId: null,
  }]);
});

test("signals canonical event-stream closure", async () => {
  const fixture = fakePeer(() => ({}));
  const events: unknown[] = [];
  await Effect.runPromise(Effect.scoped(
    new CanonicalAppServerClient(fixture.peer)
      .subscribe((event) => events.push(event)).pipe(
        Effect.zipRight(Effect.sync(fixture.close)),
        Effect.zipRight(Effect.promise(tick)),
      ),
  ));
  assert.deepEqual(events, [{ type: "closed" }]);
});

test("does not turn partial history into a negative verification", async () => {
  const fixture = fakePeer((method) => method === "thread/turns/list"
    ? { data: [turn("turn-1", [], "summary")], nextCursor: null }
    : { thread: thread("task-1", "cli") });
  const verified = await Effect.runPromise(
    new CanonicalAppServerClient(fixture.peer)
      .verifyClientMessage("task-1", "delivery-1"),
  );
  assert.deepEqual(verified, {
    status: "indeterminate",
    reason: "items-not-fully-loaded",
  });
  const historyFailure = await Effect.runPromise(Effect.flip(
    new CanonicalAppServerClient(fixture.peer).readTaskHistory("task-1"),
  ));
  assert.equal(historyFailure.code, "history-incomplete");
});

test("never replays mutations and reports submission truth", async () => {
  const confirmed = fakePeer((method) => method === "turn/start"
    ? { turn: turn("turn-1") }
    : {});
  const accepted = await Effect.runPromise(
    new CanonicalAppServerClient(confirmed.peer).startTurn({
      threadId: "task-1",
      clientUserMessageId: "delivery-1",
      input: [{ type: "text", text: "hello" }],
    }),
  );
  assert.equal(accepted.truth, "confirmed-app-server");
  assert.deepEqual(confirmed.submissions, ["turn/start"]);

  const ambiguous = fakePeer(() => ({}), { submitFailure: "ambiguous" });
  const uncertain = await Effect.runPromise(
    new CanonicalAppServerClient(ambiguous.peer).interruptTurn("task-1", "turn-1"),
  );
  assert.equal(uncertain.truth, "ambiguous");
  assert.deepEqual(ambiguous.submissions, ["turn/interrupt"]);

  const rejected = fakePeer(() => ({}), { replyFailure: "rejected" });
  const refusal = await Effect.runPromise(
    new CanonicalAppServerClient(rejected.peer).steerTurn({
      threadId: "task-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "delivery-2",
      input: [{ type: "text", text: "steer" }],
    }),
  );
  assert.equal(refusal.truth, "rejected");
  assert.deepEqual(rejected.submissions, ["turn/steer"]);

  const unavailable = fakePeer(() => ({}), {
    submitFailure: "not-written",
  });
  const notWritten = await Effect.runPromise(
    new CanonicalAppServerClient(unavailable.peer)
      .interruptTurn("task-1", "turn-1"),
  );
  assert.equal(notWritten.truth, "unavailable");
  assert.deepEqual(unavailable.submissions, ["turn/interrupt"]);

  const notConnected = fakePeer(() => ({}), { prepareFailure: true });
  const prepareFailure = await Effect.runPromise(
    new CanonicalAppServerClient(notConnected.peer)
      .interruptTurn("task-1", "turn-1"),
  );
  assert.equal(prepareFailure.truth, "unavailable");
  assert.deepEqual(notConnected.submissions, []);

  for (const replyFailure of [
    "timeout",
    "disconnected",
    "malformed",
  ] as const) {
    const fixture = fakePeer(() => ({}), { replyFailure });
    const outcome = await Effect.runPromise(
      new CanonicalAppServerClient(fixture.peer)
        .interruptTurn("task-1", "turn-1"),
    );
    assert.equal(outcome.truth, "ambiguous");
    assert.deepEqual(fixture.submissions, ["turn/interrupt"]);
  }
});

test("classifies post-submit interruption and defects as ambiguous", async () => {
  for (const replyFailure of ["interrupted", "defect"] as const) {
    const fixture = fakePeer(() => ({}), { replyFailure });
    const outcome = await Effect.runPromise(
      new CanonicalAppServerClient(fixture.peer)
        .interruptTurn("task-1", "turn-1"),
    );
    assert.equal(outcome.truth, "ambiguous");
    assert.deepEqual(fixture.submissions, ["turn/interrupt"]);
  }
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
