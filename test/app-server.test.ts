import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import { CanonicalAppServerClient } from "../src/app-server/client.js";
import { APP_SERVER_COMPATIBILITY } from "../src/app-server/compatibility.js";
import {
  CanonicalPlaneUnavailable,
  CanonicalQueryFailure,
} from "../src/app-server/errors.js";
import { confirmLocalPlane as confirmLocalService } from "../src/app-server/service.js";
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
      return { data: [thread("archived", { custom: "desktop" }, 2)], nextCursor: null };
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
  assert.equal(tasks[2]?.provenance.status, "unknown");
  assert.equal(fixture.requests.length, 3);
});

test("rejects repeated pagination cursors", async () => {
  const fixture = fakePeer(() => ({ data: [], nextCursor: "same" }));
  const failure = await Effect.runPromise(Effect.flip(
    new CanonicalAppServerClient(fixture.peer).listTasks(),
  ));
  assert.equal(failure instanceof CanonicalQueryFailure, true);
  assert.equal(failure.code, "pagination");
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
});

test("projects canonical notifications without raw params", () => {
  const fixture = fakePeer(() => ({}));
  const client = new CanonicalAppServerClient(fixture.peer);
  const events: unknown[] = [];
  const unsubscribe = client.subscribe((event) => events.push(event));
  fixture.emit({ method: "turn/started", params: { threadId: "task-1" } });
  unsubscribe();
  fixture.emit({ method: "turn/completed", params: { threadId: "task-1" } });
  assert.deepEqual(events, [{
    method: "turn/started",
    threadId: "task-1",
    turnId: null,
  }]);
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

test("requires matching local initialize provenance", async () => {
  const local = fakePeer(() => ({}));
  const service = await Effect.runPromise(confirmLocalService(local.peer, "linux"));
  assert.equal(service.identity.scope, "local-machine");
  assert.equal(service.identity.provenance, "confirmed");

  const mismatch = fakePeer(() => ({}), {
    serverInfo: {
      userAgent: "codex",
      codexHome: "/home/user/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
  const mismatchExit = await Effect.runPromiseExit(
    confirmLocalService(mismatch.peer, "linux"),
  );
  assert.equal(Exit.isFailure(mismatchExit), true);
  if (Exit.isFailure(mismatchExit)) {
    const failure = Cause.failureOption(mismatchExit.cause);
    assert.equal(
      Option.isSome(failure) &&
        failure.value instanceof CanonicalPlaneUnavailable &&
        failure.value.reason === "scope-mismatch",
      true,
    );
  }
  const remote = fakePeer(() => ({}), {
    spec: {
      _tag: "ChildProcess",
      id: "cli",
      executable: "/usr/bin/codex",
      args: ["app-server", "--code-mode-host=wss://remote.invalid"],
      approvals: "decline",
    },
  });
  const remoteFailure = await Effect.runPromise(Effect.flip(
    confirmLocalService(remote.peer, "linux"),
  ));
  assert.equal(remoteFailure.reason, "scope-mismatch");
});

test("accepts local platform metadata on every supported OS", async () => {
  const cases = [
    ["linux", "unix", "linux", "/home/user/.codex"],
    ["darwin", "unix", "macos", "/Users/user/.codex"],
    ["win32", "windows", "windows", "C:\\Users\\user\\.codex"],
  ] as const;
  for (const [platform, family, os, codexHome] of cases) {
    const fixture = fakePeer(() => ({}), {
      serverInfo: {
        userAgent: "codex",
        codexHome,
        platformFamily: family,
        platformOs: os,
      },
    });
    const service = await Effect.runPromise(
      confirmLocalService(fixture.peer, platform),
    );
    assert.equal(service.identity.platformOs, os);
  }
});

test("rejects remote Windows named-pipe paths", async () => {
  const fixture = fakePeer(() => ({}), {
    spec: {
      _tag: "UnixSocket",
      id: "daemon",
      socketPath: "\\\\remote-host\\pipe\\codex",
      approvals: "decline",
    },
    serverInfo: {
      userAgent: "codex",
      codexHome: "C:\\Users\\user\\.codex",
      platformFamily: "windows",
      platformOs: "windows",
    },
  });
  const failure = await Effect.runPromise(Effect.flip(
    confirmLocalService(fixture.peer, "win32"),
  ));
  assert.equal(failure.reason, "scope-unavailable");
});

test("declares the schema-backed app-server compatibility surface", () => {
  assert.deepEqual(APP_SERVER_COMPATIBILITY.requiredMethods, [
    "thread/list",
    "thread/read",
    "thread/turns/list",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
  ]);
});
