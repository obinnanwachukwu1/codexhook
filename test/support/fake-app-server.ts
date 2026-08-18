import { PassThrough } from "node:stream";
import type { WireConnection, WireMessage } from "../../src/transport/rpc.js";

export type FakeAppServerBehavior =
  | "normal"
  | "disconnect-before-write"
  | "disconnect-after-write"
  | "lost-acknowledgement"
  | "incompatible-initialize";

export type CanonicalItemState = "found" | "absent" | "unknown";

export interface FakeAppServerOptions {
  readonly behavior?: FakeAppServerBehavior;
  readonly canonicalItem?: CanonicalItemState;
}

export interface FakeAppServerHarness {
  readonly connection: WireConnection;
  readonly requests: ReadonlyArray<WireMessage>;
  readonly generation: number;
  disconnect: () => void;
}

export function fakeAppServer(
  options: FakeAppServerOptions = {},
  generation = 1,
): FakeAppServerHarness {
  const input = new PassThrough();
  const requests: WireMessage[] = [];
  const errorListeners = new Set<(error: Error) => void>();
  const exitListeners = new Set<(
    code: number | null,
    signal: string | null,
  ) => void>();
  const behavior = options.behavior ?? "normal";
  let alive = behavior !== "disconnect-before-write";

  const exit = () => {
    if (!alive) return;
    alive = false;
    input.end();
    for (const listener of exitListeners) listener(null, "SIGTERM");
  };

  const send = (message: WireMessage) => {
    if (alive) input.write(`${JSON.stringify(message)}\n`);
  };

  const handle = (message: WireMessage) => {
    requests.push(message);
    const id = message.id ?? "missing-id";
    if (message.method === "initialize") {
      send(behavior === "incompatible-initialize"
        ? { id, error: { code: -32_601, message: "incompatible initialize" } }
        : { id, result: { userAgent: "fake-app-server/1" } });
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "thread/resume") {
      if (options.canonicalItem === "unknown") {
        send({ id, result: { incompatible: true } });
        return;
      }
      const turns = options.canonicalItem === "found"
        ? [{ id: "turn-canonical", status: "completed", error: null }]
        : [];
      send({
        id,
        result: { thread: { id: "thread-1", turns } },
      });
      return;
    }
    if (message.method === "turn/start" || message.method === "turn/steer") {
      if (behavior === "disconnect-after-write") {
        exit();
        return;
      }
      if (behavior === "lost-acknowledgement") return;
      const turn = { id: "turn-fake", status: "inProgress", error: null };
      send({
        id,
        result: message.method === "turn/start"
          ? { turn }
          : { turnId: turn.id },
      });
      queueMicrotask(() => send({
        method: "turn/completed",
        params: { turn: { ...turn, status: "completed" } },
      }));
    }
  };

  const connection: WireConnection = {
    input,
    isAlive: () => alive,
    write(serialized, callback) {
      if (!alive) {
        callback(new Error("fake app-server is disconnected"));
        return;
      }
      let message: WireMessage;
      try {
        message = JSON.parse(serialized.trim()) as WireMessage;
      } catch (error) {
        callback(error as Error);
        return;
      }
      callback();
      handle(message);
    },
    onError(listener) {
      errorListeners.add(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
    },
  };

  return { connection, requests, generation, disconnect: exit };
}

export class FakeAppServerLifecycle {
  private currentGeneration = 0;

  start(options: FakeAppServerOptions = {}): FakeAppServerHarness {
    this.currentGeneration += 1;
    return fakeAppServer(options, this.currentGeneration);
  }
}
