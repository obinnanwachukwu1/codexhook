import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import { DesktopIpcClient } from "../src/transport/desktop-ipc-client.js";
import { TransportIncompatible } from "../src/transport/errors.js";
import { connectWirePeer } from "../src/transport/peer.js";
import { ThreadResumeResult, TurnStartResult } from "../src/transport/protocol.js";
import type { TransportSpec } from "../src/transport/spec.js";
import { ADVERSARIAL_FIXTURES } from "./fixtures/adversarial.js";
import { FakeAppServerLifecycle, fakeAppServer } from "./support/fake-app-server.js";
import { fakeDesktopIpc } from "./support/fake-desktop-ipc.js";

const appSpec = {
  _tag: "ChildProcess",
  id: "app-bundled",
  executable: "fake",
  args: [],
  approvals: "decline",
} as const satisfies TransportSpec;

test("adversarial corpus covers every phase-one integration hazard", () => {
  assert.deepEqual(
    ADVERSARIAL_FIXTURES.map((fixture) => fixture.name),
    [
      "disconnect-before-write",
      "disconnect-after-write",
      "lost-acknowledgement",
      "canonical-item-found",
      "canonical-item-absent",
      "canonical-item-unknown",
      "socket-replacement",
      "codex-restart",
      "stale-active-turn",
      "revision-gap",
      "reordered-patches",
      "incompatible-response-shapes",
      "concurrent-tasks",
      "circuit-breaker-recovery",
      "redaction",
    ],
  );
});

test("fake Desktop IPC supports socket replacement and restart generations", async () => {
  const first = await fakeDesktopIpc();
  const firstClient = await DesktopIpcClient.connect(first.socketPath);
  assert.equal(firstClient.alive, true);
  firstClient.close();

  const replacement = await first.replace();
  const secondClient = await DesktopIpcClient.connect(replacement.socketPath);
  assert.equal(replacement.generation, 2);
  replacement.disconnectClients();
  assert.equal(await eventually(() => !secondClient.alive), true);
  secondClient.close();

  const restarted = await replacement.replace();
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
      /malformed/,
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

  const after = fakeAppServer({ behavior: "disconnect-after-write" });
  const afterExit = await Effect.runPromiseExit(submitTurn(after));
  assert.equal(Exit.isFailure(afterExit), true);
  assert.equal(after.requests.some((request) => request.method === "turn/start"), true);
});

test("fake app-server models a lost acknowledgement without duplicate writes", async () => {
  const harness = fakeAppServer({ behavior: "lost-acknowledgement" });
  const exit = await Effect.runPromiseExit(submitTurn(harness, "20 millis"));
  assert.equal(Exit.isFailure(exit), true);
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

test("fake app-server lifecycle isolates concurrent tasks across restarts", async () => {
  const lifecycle = new FakeAppServerLifecycle();
  const first = lifecycle.start({ canonicalItem: "found" });
  const second = lifecycle.start({ canonicalItem: "absent" });
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  const results = await Promise.all([
    Effect.runPromise(lookup(first)),
    Effect.runPromise(lookup(second)),
  ]);
  assert.deepEqual(results, [1, 0]);
});

function lookup(harness: ReturnType<typeof fakeAppServer>) {
  return Effect.scoped(
    connectWirePeer(appSpec, harness.connection).pipe(
      Effect.flatMap((peer) => peer.request(
        "thread/resume",
        { threadId: "thread-1" },
        ThreadResumeResult,
        "50 millis",
      )),
      Effect.map((result) => result.thread.turns.length),
    ),
  );
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}
