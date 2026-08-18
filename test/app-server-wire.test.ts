import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { Effect } from "effect";
import { Logger } from "../src/logger.js";
import { connectWirePeer } from "../src/transport/peer.js";
import type {
  WireConnection,
  WireMessage,
  WireNotification,
} from "../src/transport/rpc.js";
import type { TransportSpec } from "../src/transport/spec.js";

const spec: TransportSpec = {
  _tag: "ChildProcess",
  id: "cli",
  executable: "/fake/codex",
  args: ["app-server", "--listen", "stdio://"],
  approvals: "decline",
};

function quietLogger(): Logger {
  return new Logger(new Writable({ write(_chunk, _encoding, done) { done(); } }));
}

function wire(initializeResult: unknown) {
  const input = new PassThrough();
  const writes: WireMessage[] = [];
  let alive = true;
  const connection: WireConnection = {
    input,
    isAlive: () => alive,
    write: (serialized, callback) => {
      const message = JSON.parse(serialized) as WireMessage;
      writes.push(message);
      callback();
      if (message.method === "initialize") {
        queueMicrotask(() => {
          input.write(`${JSON.stringify({
            id: message.id,
            result: initializeResult,
          })}\n`);
        });
      }
    },
    onError: () => undefined,
    onExit: () => undefined,
  };
  return {
    connection,
    input,
    writes,
    close: () => {
      alive = false;
      input.end();
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("legacy initialize shapes do not break the existing transport", async () => {
  const fixture = wire("legacy-initialize-result");
  const serverInfo = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* connectWirePeer(
        spec,
        fixture.connection,
        quietLogger(),
      );
      return peer.serverInfo;
    }),
  ));
  assert.equal(serverInfo, null);
  assert.equal(
    fixture.writes.some((message) => message.method === "initialized"),
    true,
  );
  fixture.close();
});

test("wire notifications are projected without blocking replies", async () => {
  const fixture = wire({
    userAgent: "codex_cli_rs/0.147.0",
    codexHome: "/home/user/.codex",
    platformFamily: "unix",
    platformOs: "linux",
  });
  const observed = await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* connectWirePeer(
        spec,
        fixture.connection,
        quietLogger(),
      );
      const events: WireNotification[] = [];
      peer.onNotification((event) => events.push(event));
      fixture.input.write(`${JSON.stringify({
        id: "server-request",
        method: "unknown/request",
        params: { private: "not-an-event" },
      })}\n`);
      fixture.input.write(`${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "task-1",
          turn: { id: "turn-1", status: "completed" },
        },
      })}\n`);
      yield* Effect.promise(tick);
      return { events, serverInfo: peer.serverInfo };
    }),
  ));
  assert.equal(observed.serverInfo?.platformOs, "linux");
  assert.deepEqual(observed.events.map((event) => event.method), [
    "turn/completed",
  ]);
  assert.equal(
    fixture.writes.some((message) => message.id === "server-request"),
    true,
  );
  fixture.close();
});
