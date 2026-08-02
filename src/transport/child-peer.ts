import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Effect, Scope } from "effect";
import { Logger } from "../logger.js";
import {
  TransportIncompatible,
  TransportUnavailable,
} from "./errors.js";
import { connectWirePeer } from "./peer.js";
import type { AppServerPeer } from "./rpc.js";
import type { TransportSpec } from "./spec.js";

function terminate(
  child: ChildProcessWithoutNullStreams,
): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    if (child.exitCode != null || child.signalCode != null) {
      resume(Effect.void);
      return;
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resume(Effect.void);
    });
    child.kill("SIGTERM");
  }).pipe(Effect.uninterruptible);
}

export function spawnChildPeer(
  spec: Extract<TransportSpec, { readonly _tag: "ChildProcess" }>,
  logger = new Logger(),
): Effect.Effect<
  AppServerPeer,
  TransportUnavailable | TransportIncompatible,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(spec.executable, [...spec.args], {
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsVerbatimArguments:
              spec.windowsVerbatimArguments ?? false,
          }),
        catch: (cause) =>
          new TransportUnavailable({
            transport: spec.id,
            reason: "spawn-failed",
            detail: String(cause),
          }),
      }),
      terminate,
    );
    return yield* connectWirePeer(
      spec,
      {
        input: child.stdout,
        isAlive: () =>
          child.exitCode == null &&
          child.signalCode == null &&
          !child.stdin.destroyed,
        write: (serialized, callback) => {
          child.stdin.write(serialized, callback);
        },
        onError: (listener) => {
          child.once("error", listener);
        },
        onExit: (listener) => {
          child.once("exit", listener);
        },
        onStderr: (listener) => {
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", listener);
        },
      },
      logger,
    );
  });
}
