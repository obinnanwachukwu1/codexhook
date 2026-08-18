import assert from "node:assert/strict";
import test from "node:test";
import { DesktopIpcProtocol } from "../src/transport/desktop-task-protocol.js";
import { selectDesktopAdapter, type DesktopProtocolAdapter } from
  "../src/transport/desktop-ipc/adapters.js";
import type { DesktopProtocolProfile } from
  "../src/transport/desktop-ipc/types.js";
import { restoreFollowedThreads } from
  "../src/transport/desktop-ipc/session-negotiate.js";
import { refreshDesktopOwner } from
  "../src/transport/desktop-ipc/session-owner-refresh.js";
import { sessionLimits } from "../src/transport/desktop-ipc/limits.js";
import { DesktopThreadOwners } from
  "../src/transport/desktop-ipc/thread-owners.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

const TEST_CAPABILITIES = {
  source: "legacy-inferred",
  completeHistory: true,
  startTurn: true,
  steerTurn: true,
  threadStream: true,
} as const;

function testAdapter(): DesktopProtocolAdapter {
  return selectDesktopAdapter({
    clientId: "desktop-client",
    capabilities: TEST_CAPABILITIES,
    appVersion: null,
    buildNumber: null,
    protocolVersion: 1,
  });
}

function testProfile(adapter: DesktopProtocolAdapter): DesktopProtocolProfile {
  return {
    compatibility: adapter.compatibility,
    capabilities: TEST_CAPABILITIES,
    fingerprint: {
      adapterId: adapter.id,
      appVersion: null,
      buildNumber: null,
      digest: "test",
      protocolVersion: 1,
    },
  };
}

test("Desktop injection bounds a delivery budget to the request limit", async () => {
  const endpoint = await testEndpoint();
  let starts = 0;
  let wireTimeout: number | undefined;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 1 },
          },
        });
      }
      if (message.method !== "thread-follower-start-turn") return;
      starts += 1;
      wireTimeout = (message as unknown as { timeoutMs?: number }).timeoutMs;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: { result: { turnId: "turn-started" } },
      });
    },
  );
  try {
    const protocol = await DesktopIpcProtocol.connect(endpoint.socketPath);
    try {
      await protocol.follow("thread-1");
      const reply = await protocol.inject({
        kind: "start",
        threadId: "thread-1",
        clientUserMessageId: "delivery-1",
        input: [],
        timeoutMs: 30 * 60 * 1_000,
      });
      assert.equal(reply._tag, "Accepted");
      assert.equal(starts, 1);
      assert.equal((wireTimeout ?? 0) > 29_000, true);
      assert.equal((wireTimeout ?? Infinity) <= 30_000, true);
    } finally {
      protocol.close();
    }
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("Desktop history uses the negotiated request timeout limit", async () => {
  const endpoint = await testEndpoint();
  let histories = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
    (message, send) => {
      if (message.method === "thread-stream-following-changed") {
        send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          params: {
            conversationId: "thread-1",
            change: { type: "snapshot", revision: 1 },
          },
        });
      }
      if (message.method !== "thread-follower-load-complete-history") return;
      histories += 1;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: {},
      });
    },
  );
  try {
    const protocol = await DesktopIpcProtocol.connect(
      endpoint.socketPath,
      undefined,
      undefined,
      { handshakeTimeoutMs: 100, maxRequestTimeoutMs: 100 },
    );
    try {
      await protocol.follow("thread-1");
      assert.equal(await protocol.loadHistory("thread-1"), true);
      assert.equal(histories, 1);
    } finally {
      protocol.close();
    }
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("Desktop reconnect bounds restoration of followed tasks", async () => {
  const adapter = testAdapter();
  const began = Date.now();
  await assert.rejects(
    restoreFollowedThreads(
      { broadcast: () => new Promise<void>(() => undefined) },
      adapter,
      testProfile(adapter),
      new Set(["thread-1"]),
      Date.now() + 20,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "failure" in error &&
      error.failure === "reconnect-failed" &&
      "writeState" in error &&
      error.writeState === "not-written",
  );
  assert.equal(Date.now() - began < 250, true);
});

test("owner refresh preserves its marker and original failure", async () => {
  const adapter = testAdapter();
  const followed = new Set(["thread-1"]);
  const owners = new DesktopThreadOwners();
  owners.invalidate("thread-1");
  await assert.rejects(
    refreshDesktopOwner(
      { adapter, raw: { broadcast: async () => undefined } },
      followed,
      owners,
      sessionLimits({}),
      "thread-1",
      Date.now() - 1,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "failure" in error && error.failure === "request-timeout",
  );
  assert.equal(owners.needsRefresh("thread-1"), true);

  const cause = new Error("synthetic refresh failure");
  await assert.rejects(
    refreshDesktopOwner(
      { adapter, raw: { broadcast: async () => { throw cause; } } },
      followed,
      owners,
      sessionLimits({}),
      "thread-1",
      Date.now() + 1_000,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "failure" in error && error.failure === "reconnect-failed" &&
      error.cause === cause,
  );
  assert.equal(owners.needsRefresh("thread-1"), true);
});
