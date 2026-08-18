import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import {
  DesktopIpcClient,
  DesktopIpcConnectError,
} from "../src/transport/desktop-ipc-client.js";
import { connectDesktop } from "../src/transport/desktop.js";
import {
  TransportIncompatible,
  TransportUnavailable,
} from "../src/transport/errors.js";
import { connectWirePeer } from "../src/transport/peer.js";
import type { AppServerPeer } from "../src/transport/rpc.js";
import { ThreadResumeResult, TurnStartResult } from "../src/transport/protocol.js";
import type { TransportSpec } from "../src/transport/spec.js";
import { fakeAppServer } from "./support/fake-app-server.js";
import { fakeDesktopIpc } from "./support/fake-desktop-ipc.js";

const appSpec = {
  _tag: "ChildProcess",
  id: "app-bundled",
  executable: "fake",
  args: [],
  approvals: "decline",
} as const satisfies TransportSpec;

test("fake Desktop IPC supports socket replacement and restart generations", async () => {
  const first = await fakeDesktopIpc();
  assert.equal(await connectDesktopAlive(first.socketPath), true);

  const replacement = await first.replace();
  const secondClient = await DesktopIpcClient.connect(replacement.socketPath);
  assert.equal(replacement.generation, 2);
  replacement.disconnectClients();
  assert.equal(await eventually(() => !secondClient.alive), true);
  secondClient.close();

  const restarted = await replacement.replace();
  assert.equal(await connectDesktopAlive(restarted.socketPath), true);
  const thirdClient = await DesktopIpcClient.connect(restarted.socketPath);
  assert.equal(restarted.generation, 3);
  thirdClient.close();
  await restarted.close();
});

test("fake Desktop IPC exposes incompatible response shapes", async () => {
  const harness = await fakeDesktopIpc("incompatible-response");
  try {
    await assert.rejects(
      DesktopIpcClient.connect(harness.socketPath),
      (error) => error instanceof DesktopIpcConnectError &&
        error.failure === "initialize-malformed",
    );
  } finally {
    await harness.close();
  }
});

test("fake app-server distinguishes disconnect before and after write", async () => {
  const before = fakeAppServer({ behavior: "disconnect-before-write" });
  const beforeExit = await Effect.runPromiseExit(
    Effect.scoped(connectWirePeer(appSpec, before.connection)),
  );
  assert.equal(Exit.isFailure(beforeExit), true);
  if (Exit.isFailure(beforeExit)) {
    const failure = Cause.failureOption(beforeExit.cause);
    assert.equal(
      Option.isSome(failure) && failure.value instanceof TransportUnavailable,
      true,
    );
  }

  const after = fakeAppServer({ behavior: "disconnect-after-write" });
  const afterExit = await Effect.runPromiseExit(submitTurn(after));
  assert.equal(Exit.isFailure(afterExit), true);
  assertFailure(afterExit, ["RpcWriteAmbiguous", "RpcDisconnected"]);
  assert.equal(after.requests.some((request) => request.method === "turn/start"), true);
});

test("fake app-server models a lost acknowledgement without duplicate writes", async () => {
  const harness = fakeAppServer({ behavior: "lost-acknowledgement" });
  const exit = await Effect.runPromiseExit(submitTurn(harness, "200 millis"));
  assert.equal(Exit.isFailure(exit), true);
  assertFailure(exit, ["RpcTimeout"]);
  assert.equal(
    harness.requests.filter((request) => request.method === "turn/start").length,
    1,
  );
});

test("fake app-server can reject an incompatible initialize shape", async () => {
  const harness = fakeAppServer({ behavior: "incompatible-initialize" });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(connectWirePeer(appSpec, harness.connection)),
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    assert.equal(
      Option.isSome(failure) && failure.value instanceof TransportIncompatible,
      true,
    );
  }
});

test("fake app-server canonical lookup reports found, absent, and unknown", async () => {
  for (const state of ["found", "absent", "unknown"] as const) {
    const harness = fakeAppServer({ canonicalItem: state });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        connectWirePeer(appSpec, harness.connection).pipe(
          Effect.flatMap((peer) => peer.request(
            "thread/resume",
            { threadId: "thread-1" },
            ThreadResumeResult,
            "50 millis",
          )),
        ),
      ),
    );
    if (state === "unknown") {
      assert.equal(Exit.isFailure(exit), true);
    } else {
      assert.equal(Exit.isSuccess(exit), true);
      if (Exit.isSuccess(exit)) {
        assert.equal(exit.value.thread.turns.length, state === "found" ? 1 : 0);
      }
    }
  }
});

test("fake app-server handles concurrent tasks on one connection", async () => {
  const harness = fakeAppServer({
    canonicalItems: { "thread-1": "found", "thread-2": "absent" },
  });
  const results = await Effect.runPromise(Effect.scoped(
    connectWirePeer(appSpec, harness.connection).pipe(
      Effect.flatMap((peer) => Effect.all([
        canonicalCount(peer, "thread-1"),
        canonicalCount(peer, "thread-2"),
      ], { concurrency: "unbounded" })),
    ),
  ));
  assert.deepEqual(results, [1, 0]);
});

function canonicalCount(
  peer: AppServerPeer,
  threadId: string,
) {
  return peer.request(
    "thread/resume",
    { threadId },
    ThreadResumeResult,
    "50 millis",
  ).pipe(Effect.map((result) => result.thread.turns.length));
}

function submitTurn(
  harness: ReturnType<typeof fakeAppServer>,
  timeout: `${number} millis` = "50 millis",
) {
  return Effect.scoped(
    connectWirePeer(appSpec, harness.connection).pipe(
      Effect.flatMap((peer) => peer.prepare("turn/start", {
        threadId: "thread-1",
        input: [{ type: "text", text: "payload" }],
      }).pipe(
        Effect.tap((ticket) => peer.submit(ticket)),
        Effect.flatMap((ticket) => peer.reply(ticket, TurnStartResult, timeout)),
      )),
    ),
  );
}

async function eventually(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function connectDesktopAlive(socketPath: string): Promise<boolean> {
  const spec = {
    _tag: "Desktop",
    id: "desktop",
    socketPath,
    approvals: "decline",
  } as const satisfies TransportSpec;
  return Effect.runPromise(Effect.scoped(
    connectDesktop(spec).pipe(Effect.flatMap((peer) => peer.isAlive)),
  ));
}

function assertFailure(
  exit: Exit.Exit<unknown, unknown>,
  expected: ReadonlyArray<string>,
): void {
  if (!Exit.isFailure(exit)) assert.fail("expected failure");
  const failure = Cause.failureOption(exit.cause);
  assert.equal(
    Option.isSome(failure) && expected.includes(
      String((failure.value as { readonly _tag?: unknown })._tag),
    ),
    true,
  );
}
