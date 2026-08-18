import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { DesktopProtocolError } from "../src/transport/desktop-ipc/errors.js";
import {
  RawDesktopConnection,
  type DesktopWireLimits,
} from "../src/transport/desktop-ipc/wire.js";

const limits: DesktopWireLimits = {
  maxInboundFrameBytes: 1_024,
  maxOutboundFrameBytes: 1_024,
  maxPendingRequests: 1,
  maxRequestTimeoutMs: 1_000,
  minRequestTimeoutMs: 1,
};

function openWith(
  socket: net.Socket,
  connectTimeoutMs: number,
  onOpeningSocket: (socket: net.Socket | null) => void,
) {
  return RawDesktopConnection.open(
    "/unused/desktop.sock",
    limits,
    () => undefined,
    () => undefined,
    {
      connectTimeoutMs,
      createConnection: () => socket,
      onOpeningSocket,
    },
  );
}

test("a hanging Desktop socket open fails within its connect budget", async () => {
  const socket = new net.Socket();
  const owned: Array<net.Socket | null> = [];
  const startedAt = Date.now();
  await assert.rejects(
    openWith(socket, 10, (current) => owned.push(current)),
    (error: unknown) =>
      error instanceof DesktopProtocolError &&
      error.failure === "connect-timeout" &&
      error.stage === "connect" &&
      error.writeState === "not-written",
  );
  assert.equal(Date.now() - startedAt < 250, true);
  assert.equal(socket.destroyed, true);
  assert.deepEqual(owned, [socket, null]);
});

test("closing an owned Desktop socket aborts an in-flight open", async () => {
  const socket = new net.Socket();
  let opening: net.Socket | null = null;
  let notifyOwned!: (socket: net.Socket) => void;
  const owned = new Promise<net.Socket>((resolve) => {
    notifyOwned = resolve;
  });
  const pending = openWith(socket, 1_000, (current) => {
    opening = current;
    if (current != null) notifyOwned(current);
  });
  const current = await owned;
  const startedAt = Date.now();
  current.destroy();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DesktopProtocolError && error.failure === "closed",
  );
  assert.equal(Date.now() - startedAt < 250, true);
  assert.equal(opening, null);
});
