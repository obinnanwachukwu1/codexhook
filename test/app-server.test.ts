import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Deferred, Effect, Exit, FiberId, Option, Schema } from "effect";
import { CanonicalAppServerClient } from "../src/app-server/client.js";
import { APP_SERVER_COMPATIBILITY } from "../src/app-server/compatibility.js";
import { CanonicalPlaneUnavailable } from "../src/app-server/errors.js";
import { confirmLocalPlane as confirmLocalService } from "../src/app-server/service.js";
import {
  type AppServerPeer,
  RpcErrorReply,
  RpcMalformed,
  RpcNotWritten,
  RpcTimeout,
  RpcWriteAmbiguous,
  type WireNotification,
} from "../src/transport/rpc.js";
import type { TransportSpec } from "../src/transport/spec.js";

interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

interface FakePeer {
  readonly peer: AppServerPeer;
  readonly requests: RecordedRequest[];
  readonly submissions: string[];
  emit(message: WireNotification): void;
}

type Handler = (method: string, params: unknown) => unknown;

function turn(id: string, items: ReadonlyArray<unknown> = []) {
  return {
    id,
    items,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

function thread(id: string, source: unknown, updatedAt = 1) {
  return {
    id,
    preview: `preview ${id}`,
    ephemeral: false,
    createdAt: 1,
    updatedAt,
    status: { type: "idle" },
    cwd: "/workspace",
    cliVersion: "0.147.0",
    source,
    canAcceptDirectInput: true,
    name: null,
    turns: [],
  };
}

function fakePeer(
  handler: Handler,
  options: {
    readonly spec?: TransportSpec;
    readonly submitFailure?: "not-written" | "ambiguous";
    readonly replyFailure?: "rejected" | "timeout";
    readonly serverInfo?: AppServerPeer["serverInfo"];
  } = {},
): FakePeer {
  const requests: RecordedRequest[] = [];
  const submissions: string[] = [];
  const listeners = new Set<(message: WireNotification) => void>();
  let sequence = 0;
  const spec = options.spec ?? {
    _tag: "ChildProcess",
    id: "cli",
    executable: "/usr/bin/codex",
    args: [],
    approvals: "decline",
  };
  const peer: AppServerPeer = {
    spec,
    serverInfo: options.serverInfo === undefined
      ? {
          userAgent: "codex_cli_rs/0.147.0",
          codexHome: "/home/user/.codex",
          platformFamily: "unix",
          platformOs: "linux",
        }
      : options.serverInfo,
    isAlive: Effect.succeed(true),
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => Effect.void,
    prepare: (method, params) => {
      requests.push({ method, params });
      return Effect.succeed({
        id: `fake-${++sequence}`,
        method,
        serialized: JSON.stringify({ method, params }),
        reply: Deferred.unsafeMake(FiberId.none),
      });
    },
    submit: (ticket) => {
      submissions.push(ticket.method);
      if (options.submitFailure === "not-written") {
        return Effect.fail(new RpcNotWritten({ detail: "closed before write" }));
      }
      if (options.submitFailure === "ambiguous") {
        return Effect.fail(new RpcWriteAmbiguous({ detail: "closed after write" }));
      }
      return Effect.void;
    },
    reply: <A, I>(ticket: { readonly method: string }, schema: Schema.Schema<A, I>) => {
      if (options.replyFailure === "rejected") {
        return Effect.fail(new RpcErrorReply({ code: -32602, message: "rejected" }));
      }
      if (options.replyFailure === "timeout") {
        return Effect.fail(new RpcTimeout({ millis: 30_000 }));
      }
      const request = requests.findLast((entry) => entry.method === ticket.method);
      return Schema.decodeUnknown(schema)(
        handler(ticket.method, request?.params),
      ).pipe(
        Effect.mapError((error) =>
          new RpcMalformed({ detail: error.message })),
      );
    },
    request: <A, I>(method: string, params: unknown, schema: Schema.Schema<A, I>) => {
      requests.push({ method, params });
      return Schema.decodeUnknown(schema)(handler(method, params)).pipe(
        Effect.mapError((error) =>
          new RpcMalformed({ detail: error.message })),
      );
    },
    awaitTurn: (turnId) => Effect.succeed({ id: turnId, status: "completed" }),
  };
  return {
    peer,
    requests,
    submissions,
    emit: (message) => {
      for (const listener of listeners) listener(message);
    },
  };
}

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
  assert.equal(history.completeness, "complete");
  assert.equal(history.pagesRead, 2);
  assert.deepEqual(history.thread.turns.map((item) => item.id), ["turn-1", "turn-2"]);
  const verified = await Effect.runPromise(
    client.verifyClientMessage("task-1", "delivery-1"),
  );
  assert.equal(verified.status, "confirmed");
});

test("forwards canonical notifications with local scope", () => {
  const fixture = fakePeer(() => ({}));
  const client = new CanonicalAppServerClient(fixture.peer);
  const events: unknown[] = [];
  const unsubscribe = client.subscribe((event) => events.push(event));
  fixture.emit({ method: "turn/started", params: { threadId: "task-1" } });
  unsubscribe();
  fixture.emit({ method: "turn/completed", params: { threadId: "task-1" } });
  assert.deepEqual(events, [{
    scope: "local-machine",
    method: "turn/started",
    params: { threadId: "task-1" },
    threadId: "task-1",
  }]);
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
  assert.equal(APP_SERVER_COMPATIBILITY.requiredMethods.includes("thread/turns/list"), true);

  const remote = fakePeer(() => ({}), {
    spec: {
      _tag: "ChildProcess",
      id: "cli",
      executable: "/usr/bin/codex",
      args: ["app-server", "--code-mode-host", "wss://remote.invalid"],
      approvals: "decline",
    },
  });
  const remoteExit = await Effect.runPromiseExit(
    confirmLocalService(remote.peer, "linux"),
  );
  assert.equal(Exit.isFailure(remoteExit), true);
});
