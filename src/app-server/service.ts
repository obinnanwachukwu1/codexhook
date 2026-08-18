import path from "node:path";
import {
  Context,
  Effect,
  ExecutionStrategy,
  Exit,
  Layer,
  Scope,
} from "effect";
import type { TransportId } from "../types.js";
import type { AppServerPeer } from "../transport/rpc.js";
import { TransportProvider } from "../transport/provider.js";
import type { TransportSpec } from "../transport/spec.js";
import { CanonicalAppServerClient } from "./client.js";
import { CanonicalPlaneUnavailable } from "./errors.js";

export interface LocalPlaneIdentity {
  readonly scope: "local-machine";
  readonly provenance: "confirmed";
  readonly transport: Exclude<TransportId, "desktop">;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export interface CanonicalAppServerService {
  readonly availability: Effect.Effect<
    | {
        readonly status: "available";
        readonly identity: LocalPlaneIdentity;
      }
    | {
        readonly status: "unavailable";
        readonly reason: "disconnected";
      }
  >;
  readonly identity: LocalPlaneIdentity;
  readonly client: CanonicalAppServerClient;
}

export class CanonicalAppServer extends Context.Tag(
  "codexhook/CanonicalAppServer",
)<CanonicalAppServer, CanonicalAppServerService>() {}

function expectedPlatform(platform: NodeJS.Platform): {
  readonly family: "unix" | "windows";
  readonly os: string;
} {
  if (platform === "win32") return { family: "windows", os: "windows" };
  return {
    family: "unix",
    os: platform === "darwin" ? "macos" : platform,
  };
}

function absoluteForPlatform(
  pathname: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32"
    ? path.win32.isAbsolute(pathname)
    : path.posix.isAbsolute(pathname);
}

function localSocketPath(
  pathname: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") return path.posix.isAbsolute(pathname);
  const normalized = pathname.toLowerCase();
  return normalized.startsWith("\\\\.\\pipe\\") ||
    normalized.startsWith("\\\\?\\pipe\\");
}

export function confirmLocalPlane(
  peer: AppServerPeer,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<CanonicalAppServerService, CanonicalPlaneUnavailable> {
  return Effect.gen(function* () {
    if (peer.spec._tag === "Desktop") {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-unavailable",
        detail: "Desktop IPC is not the canonical app-server plane",
      });
    }
    if (
      peer.spec._tag === "ChildProcess" &&
      peer.spec.args.some((argument) =>
        argument === "--code-mode-host" ||
        argument.startsWith("--code-mode-host="))
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-mismatch",
        detail: "remote code-mode app-server targets are not supported",
      });
    }
    if (
      peer.spec._tag === "UnixSocket" &&
      !localSocketPath(peer.spec.socketPath, platform)
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-unavailable",
        detail: "app-server socket path is not an absolute local endpoint",
      });
    }
    const info = peer.serverInfo;
    if (
      info?.userAgent == null ||
      info.codexHome == null ||
      info.platformFamily == null ||
      info.platformOs == null ||
      !absoluteForPlatform(info.codexHome, platform)
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-unavailable",
        detail: "app-server did not provide complete local scope metadata",
      });
    }
    const expected = expectedPlatform(platform);
    if (
      info.platformFamily !== expected.family ||
      info.platformOs !== expected.os
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-mismatch",
        detail: "app-server platform does not match the local machine",
      });
    }
    const identity: LocalPlaneIdentity = {
      scope: "local-machine",
      provenance: "confirmed",
      transport: peer.spec.id,
      platformFamily: info.platformFamily,
      platformOs: info.platformOs,
    };
    return {
      availability: peer.isAlive.pipe(
        Effect.map((alive) => alive
          ? { status: "available" as const, identity }
          : {
              status: "unavailable" as const,
              reason: "disconnected" as const,
            }),
      ),
      identity,
      client: new CanonicalAppServerClient(peer),
    };
  });
}

function localCandidates(
  candidates: ReadonlyArray<TransportSpec>,
): ReadonlyArray<Exclude<TransportSpec, { readonly _tag: "Desktop" }>> {
  return candidates.filter(
    (candidate): candidate is Exclude<
      TransportSpec,
      { readonly _tag: "Desktop" }
    > => candidate._tag !== "Desktop",
  );
}

function connectFirstLocal(
  provider: Context.Tag.Service<TransportProvider>,
  candidates: ReadonlyArray<
    Exclude<TransportSpec, { readonly _tag: "Desktop" }>
  >,
  failures: string[] = [],
): Effect.Effect<
  CanonicalAppServerService,
  CanonicalPlaneUnavailable,
  Scope.Scope
> {
  const [candidate, ...rest] = candidates;
  if (candidate == null) {
    return Effect.fail(
      new CanonicalPlaneUnavailable({
        reason: "no-local-app-server",
        detail: failures.length === 0
          ? "no local app-server candidate is installed"
          : `local candidates rejected: ${failures.join(", ")}`,
      }),
    );
  }
  return Effect.gen(function* () {
    const parent = yield* Scope.Scope;
    const child = yield* Scope.fork(
      parent,
      ExecutionStrategy.sequential,
    );
    const attempt = yield* provider.connect(candidate).pipe(
      Effect.flatMap((peer) => confirmLocalPlane(peer)),
      Scope.extend(child),
      Effect.exit,
    );
    if (Exit.isSuccess(attempt)) return attempt.value;
    yield* Scope.close(child, attempt);
    return yield* connectFirstLocal(provider, rest, [
      ...failures,
      candidate.id,
    ]);
  });
}

export const CanonicalAppServerLive: Layer.Layer<
  CanonicalAppServer,
  CanonicalPlaneUnavailable,
  TransportProvider
> = Layer.scoped(
  CanonicalAppServer,
  Effect.gen(function* () {
    const provider = yield* TransportProvider;
    const candidates = localCandidates(yield* provider.candidates);
    return yield* connectFirstLocal(provider, candidates);
  }),
);
