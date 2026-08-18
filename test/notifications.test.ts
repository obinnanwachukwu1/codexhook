import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Deferred } from "effect";
import { AppServerNotifications } from "../src/transport/notifications.js";
import { RpcDisconnected } from "../src/transport/rpc.js";

test("notification observer failures are isolated from the peer", async () => {
  const notifications = new AppServerNotifications();
  const disconnected = await Effect.runPromise(
    Deferred.make<never, RpcDisconnected>(),
  );
  let observed = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          notifications.observe(disconnected, () => {
            throw new Error("observer failed");
          }),
        );
        yield* Effect.forkScoped(
          notifications.observe(disconnected, () => {
            observed = true;
          }),
        );
        yield* Effect.yieldNow();
        yield* notifications.emit("thread/started", {});
      }),
    ),
  );
  assert.equal(observed, true);
});
