import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryFailure,
  deliverySuccess,
} from "../src/service/delivery-coordinator.js";
import { DeliveryId, ThreadId, TurnId } from "../src/types.js";
import {
  DesktopVisibilityUnconfirmed,
  NoTransportAvailable,
  SubmitAmbiguous,
  SubmitRejected,
  TurnTimeout,
} from "../src/transport/errors.js";

const threadId = ThreadId("thread-1");
const turnId = TurnId("turn-1");

test("delivery reports confirmed Desktop and app-server routes", () => {
  assert.equal(
    deliverySuccess({
      _tag: "Completed",
      threadId,
      turnId,
      transport: "desktop",
    }).state,
    "confirmed-desktop",
  );
  assert.equal(
    deliverySuccess({
      _tag: "Completed",
      threadId,
      turnId,
      transport: "daemon",
    }).state,
    "confirmed-app-server",
  );
  assert.deepEqual(
    deliveryFailure(
      new DesktopVisibilityUnconfirmed({
        threadId,
        turnId,
        submittedTransport: "cli",
        detail: "Desktop did not refresh",
      }),
    ),
    {
      state: "confirmed-app-server",
      outcome: null,
      transport: "cli",
    },
  );
});

test("delivery reports ambiguous, unavailable, and rejected outcomes", () => {
  assert.equal(
    deliveryFailure(
      new SubmitAmbiguous({
        threadId,
        deliveryId: DeliveryId("delivery-1"),
        transport: "desktop",
        method: "turn/start",
        cause: "disconnected",
      }),
    ).state,
    "ambiguous",
  );
  assert.equal(
    deliveryFailure(new NoTransportAvailable({ attempts: [] })).state,
    "unavailable",
  );
  assert.equal(
    deliveryFailure(
      new SubmitRejected({
        transport: "daemon",
        method: "turn/start",
        code: -32_000,
        message: "rejected",
      }),
    ).state,
    "rejected",
  );
  assert.equal(
    deliveryFailure(
      new TurnTimeout({
        threadId,
        turnId,
        transport: "desktop",
        waitedMillis: 10,
      }),
    ).state,
    "confirmed-desktop",
  );
});
