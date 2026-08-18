import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopFrameDecoder,
  DesktopProtocolError,
  DesktopProtocolSession,
  encodeDesktopFrame,
} from "../src/transport/desktop-protocol/index.js";
import type { DesktopWireEnvelope } from "../src/transport/desktop-protocol/index.js";

type MessageHandler = (
  message: DesktopWireEnvelope,
  send: (message: unknown) => void,
  sendRaw: (frame: Buffer) => void,
) => void;

interface Router {
  readonly close: () => Promise<void>;
}

const fixtures = path.join(
  process.cwd(),
  "test",
  "fixtures",
  "desktop-protocol",
);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
}

async function listen(
  socketPath: string,
  initialize: unknown,
  handler: MessageHandler = () => undefined,
): Promise<Router> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = new DesktopFrameDecoder();
    const send = (message: unknown) => socket.write(encodeDesktopFrame(message));
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.method === "initialize") {
          if (initialize != null) {
            send({
              type: "response",
              requestId: message.requestId,
              resultType: "success",
              result: initialize,
            });
          }
          continue;
        }
        handler(message, send, (frame) => socket.write(frame));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function testEndpoint(): Promise<{
  readonly directory: string;
  readonly socketPath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhook-protocol-"));
  return {
    directory,
    socketPath: process.platform === "win32"
      ? `\\\\.\\pipe\\codexhook-protocol-${randomUUID()}`
      : path.join(directory, "ipc.sock"),
  };
}

test("selects legacy and explicit v1 adapters across response shapes", async () => {
  for (const entry of [
    {
      initialize: "initialize-legacy.json",
      start: "start-legacy.json",
      adapterId: "desktop-ipc/v1-legacy",
      turnId: "turn-legacy",
    },
    {
      initialize: "initialize-v1.json",
      start: "start-v1.json",
      adapterId: "desktop-ipc/v1",
      turnId: "turn-versioned",
    },
  ]) {
    const endpoint = await testEndpoint();
    const start = await fixture(entry.start);
    const router = await listen(
      endpoint.socketPath,
      await fixture(entry.initialize),
      (message, send) => {
        if (message.method === "thread-follower-start-turn") {
          send({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: start,
          });
        }
      },
    );
    try {
      const session = await DesktopProtocolSession.connect(endpoint.socketPath);
      assert.equal(session.profile.fingerprint.adapterId, entry.adapterId);
      assert.equal(session.profile.fingerprint.digest.length, 24);
      const receipt = await session.startTurn("thread-1", {}, 1_000);
      assert.equal(receipt.outcome._tag, "Accepted");
      if (receipt.outcome._tag === "Accepted") {
        assert.equal(receipt.outcome.value.turnId, entry.turnId);
      }
      session.close();
    } finally {
      await router.close();
      await rm(endpoint.directory, { recursive: true, force: true });
    }
  }
});

test("rejects an explicitly unknown protocol version", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-unknown.json"),
  );
  try {
    await assert.rejects(
      DesktopProtocolSession.connect(endpoint.socketPath),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "unknown-protocol-version",
    );
  } finally {
    await router.close();
    await rm(endpoint.directory, { recursive: true, force: true });
  }
});

test("bounds and rejects malformed frame lengths, JSON, and envelopes", () => {
  const combined = Buffer.concat([
    encodeDesktopFrame({ type: "broadcast", params: "a".repeat(120) }),
    encodeDesktopFrame({ type: "broadcast", params: "b".repeat(120) }),
  ]);
  assert.equal(combined.length > 260, true);
  assert.equal(new DesktopFrameDecoder(256).push(combined).length, 2);

  const zeroLength = Buffer.alloc(4);
  assert.throws(
    () => new DesktopFrameDecoder(64).push(zeroLength),
    DesktopProtocolError,
  );

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(65);
  assert.throws(
    () => new DesktopFrameDecoder(64).push(oversized),
    DesktopProtocolError,
  );

  const invalidJson = Buffer.concat([
    Buffer.from([1, 0, 0, 0]),
    Buffer.from("{"),
  ]);
  assert.throws(
    () => new DesktopFrameDecoder(64).push(invalidJson),
    DesktopProtocolError,
  );
  assert.throws(
    () => new DesktopFrameDecoder(64).push(encodeDesktopFrame([])),
    DesktopProtocolError,
  );
});

test("fails an in-flight request when the router sends a malformed frame", async () => {
  const endpoint = await testEndpoint();
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, _send, sendRaw) => {
      if (message.method === "thread-follower-start-turn") {
        sendRaw(Buffer.alloc(4));
      }
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await assert.rejects(
      session.startTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "frame-invalid" &&
        error.writeState === "unknown",
    );
  } finally {
    await router.close();
    await rm(endpoint.directory, { recursive: true, force: true });
  }
});

test("times out without retrying an uncertain request", async () => {
  const endpoint = await testEndpoint();
  let starts = 0;
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message) => {
      if (message.method === "thread-follower-start-turn") starts += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await assert.rejects(
      session.startTurn("thread-1", {}, 20),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "request-timeout" &&
        error.writeState === "unknown",
    );
    assert.equal(starts, 1);
  } finally {
    await router.close();
    await rm(endpoint.directory, { recursive: true, force: true });
  }
});

test("correlates concurrent responses that arrive out of order", async () => {
  const endpoint = await testEndpoint();
  const pending: DesktopWireEnvelope[] = [];
  const router = await listen(
    endpoint.socketPath,
    await fixture("initialize-legacy.json"),
    (message, send) => {
      pending.push(message);
      if (pending.length !== 2) return;
      for (const [message, turnId] of [
        [pending[1], "turn-second"],
        [pending[0], "turn-first"],
      ] as const) {
        send({
          type: "response",
          requestId: message?.requestId,
          resultType: "success",
          result: { result: { turn: { id: turnId } } },
        });
      }
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    const [first, second] = await Promise.all([
      session.startTurn("thread-1", { ordinal: 1 }, 1_000),
      session.startTurn("thread-1", { ordinal: 2 }, 1_000),
    ]);
    assert.equal(
      first.outcome._tag === "Accepted" && first.outcome.value.turnId,
      "turn-first",
    );
    assert.equal(
      second.outcome._tag === "Accepted" && second.outcome.value.turnId,
      "turn-second",
    );
  } finally {
    await router.close();
    await rm(endpoint.directory, { recursive: true, force: true });
  }
});

test("reconnects future operations after socket replacement without replay", async () => {
  const endpoint = await testEndpoint();
  const initialize = await fixture("initialize-legacy.json");
  const firstRouter = await listen(endpoint.socketPath, initialize);
  const session = await DesktopProtocolSession.connect(endpoint.socketPath);
  await firstRouter.close();

  let starts = 0;
  const secondRouter = await listen(
    endpoint.socketPath,
    initialize,
    (message, send) => {
      if (message.method !== "thread-follower-start-turn") return;
      starts += 1;
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        result: { result: { turn: { id: "turn-reconnected" } } },
      });
    },
  );
  try {
    const receipt = await session.startTurn("thread-1", {}, 1_000);
    assert.equal(
      receipt.outcome._tag === "Accepted" && receipt.outcome.value.turnId,
      "turn-reconnected",
    );
    assert.equal(starts, 1);
  } finally {
    session.close();
    await secondRouter.close();
    await rm(endpoint.directory, { recursive: true, force: true });
  }
});

test("rejects an unadvertised capability before writing operation bytes", async () => {
  const endpoint = await testEndpoint();
  let starts = 0;
  const router = await listen(
    endpoint.socketPath,
    {
      clientId: "limited-client",
      protocolVersion: 1,
      capabilities: ["threadStream"],
    },
    (message) => {
      if (message.method === "thread-follower-start-turn") starts += 1;
    },
  );
  try {
    const session = await DesktopProtocolSession.connect(endpoint.socketPath);
    await assert.rejects(
      session.startTurn("thread-1", {}, 1_000),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "unsupported-capability" &&
        error.writeState === "not-written",
    );
    assert.equal(starts, 0);
  } finally {
    await router.close();
    await rm(endpoint.directory, { recursive: true, force: true });
  }
});
