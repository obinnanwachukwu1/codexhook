import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { connectDesktop } from "../src/transport/desktop.js";
import type { TransportSpec } from "../src/transport/spec.js";
import {
  fixture,
  listen,
  testEndpoint,
} from "./support/desktop-ipc-router.js";

test("Desktop bridge exposes no canonical app-server metadata or events", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-v1.json"),
  );
  const spec = {
    _tag: "Desktop",
    id: "desktop",
    socketPath: endpoint.socketPath,
    approvals: "decline",
  } as const satisfies TransportSpec;
  try {
    const closed = await Effect.runPromise(Effect.scoped(
      connectDesktop(spec).pipe(
        Effect.flatMap((peer) => Effect.promise(async () => {
          assert.equal(peer.serverInfo, null);
          let streamClosed = false;
          const unsubscribe = peer.onNotification(
            () => assert.fail("Desktop emitted an app-server notification"),
            () => {
              streamClosed = true;
            },
          );
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          unsubscribe();
          return streamClosed;
        })),
      ),
    ));
    assert.equal(closed, true);
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});
