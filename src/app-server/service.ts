import os from "node:os";
import path from "node:path";
import {
  Cause,
  Context,
  Effect,
  ExecutionStrategy,
  Exit,
  Layer,
  Option,
  Scope,
} from "effect";
import type { TransportId } from "../types.js";
import type { AppServerPeer } from "../transport/rpc.js";
import { TransportProvider } from "../transport/provider.js";
import type { TransportSpec } from "../transport/spec.js";
import { CanonicalAppServerClient } from "./client.js";
import { APP_SERVER_COMPATIBILITY } from "./compatibility.js";
import { CanonicalPlaneUnavailable } from "./errors.js";
import type { AppServerCompatibility } from "./compatibility.js";

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
    | {
        readonly status: "unavailable";
        readonly reason: CanonicalPlaneUnavailable["reason"];
        readonly cause: CanonicalPlaneUnavailable["cause"];
        readonly rejectedCandidates: CanonicalPlaneUnavailable["rejectedCandidates"];
      }
  >;
  readonly identity: LocalPlaneIdentity | null;
  readonly client: CanonicalAppServerClient | null;
  readonly compatibility: AppServerCompatibility;
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
    normalized.startsWith("\\\\?\\pipe\\") ||
    /^[a-z]:[\\/]/i.test(pathname);
}

function normalizeStorePath(
  pathname: string,
  platform: NodeJS.Platform,
): string {
  const normalized = platform === "win32"
    ? path.win32.resolve(pathname).toLowerCase()
    : path.posix.resolve(pathname);
  return normalized.replace(/[\\/]+$/, "");
}

export function localCodexHome(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.resolve(
    environment.CODEX_HOME ?? pathApi.join(homeDirectory, ".codex"),
  );
}

export function confirmLocalPlane(
  peer: AppServerPeer,
  platform: NodeJS.Platform = process.platform,
  expectedCodexHome: string = localCodexHome(process.env, platform),
): Effect.Effect<CanonicalAppServerService, CanonicalPlaneUnavailable> {
  return Effect.gen(function* () {
    if (peer.spec._tag === "Desktop") {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-unavailable",
        cause: "desktop-plane",
        rejectedCandidates: [],
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
        cause: "remote-code-mode-host",
        rejectedCandidates: [],
      });
    }
    if (
      peer.spec._tag === "UnixSocket" &&
      !localSocketPath(peer.spec.socketPath, platform)
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-unavailable",
        cause: "non-local-socket",
        rejectedCandidates: [],
      });
    }
    const info = peer.serverInfo;
    if (info == null || !absoluteForPlatform(info.codexHome, platform)) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-unavailable",
        cause: "incomplete-metadata",
        rejectedCandidates: [],
      });
    }
    const expected = expectedPlatform(platform);
    if (
      info.platformFamily !== expected.family ||
      info.platformOs !== expected.os
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-mismatch",
        cause: "platform-mismatch",
        rejectedCandidates: [],
      });
    }
    if (
      normalizeStorePath(info.codexHome, platform) !==
        normalizeStorePath(expectedCodexHome, platform)
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-mismatch",
        cause: "store-mismatch",
        rejectedCandidates: [],
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
      compatibility: APP_SERVER_COMPATIBILITY,
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

function localSpec(
  candidate: Exclude<TransportSpec, { readonly _tag: "Desktop" }>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    candidate._tag === "ChildProcess" &&
    candidate.args.some((argument) =>
      argument === "--code-mode-host" ||
      argument.startsWith("--code-mode-host="))
  ) {
    return false;
  }
  return candidate._tag !== "UnixSocket" ||
    localSocketPath(candidate.socketPath, platform);
}

function connectFirstLocal(
  provider: Context.Tag.Service<TransportProvider>,
  candidates: ReadonlyArray<
    Exclude<TransportSpec, { readonly _tag: "Desktop" }>
  >,
  failures: Array<Exclude<TransportId, "desktop">> = [],
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
        cause: failures.length === 0 ? "no-candidate" : "candidates-rejected",
        rejectedCandidates: failures,
      }),
    );
  }
  if (!localSpec(candidate)) {
    return connectFirstLocal(provider, rest, [...failures, candidate.id]);
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
    if (Option.isNone(Cause.failureOption(attempt.cause))) {
      return yield* Effect.failCause(
        attempt.cause as Cause.Cause<CanonicalPlaneUnavailable>,
      );
    }
    return yield* connectFirstLocal(provider, rest, [
      ...failures,
      candidate.id,
    ]);
  });
}

export const CanonicalAppServerLive: Layer.Layer<
  CanonicalAppServer,
  never,
  TransportProvider
> = Layer.scoped(
  CanonicalAppServer,
  Effect.flatMap(TransportProvider, acquireCanonicalAppServer),
);

export function acquireCanonicalAppServer(
  provider: Context.Tag.Service<TransportProvider>,
): Effect.Effect<CanonicalAppServerService, never, Scope.Scope> {
  return provider.appServerCandidates.pipe(
    Effect.map(localCandidates),
    Effect.flatMap((candidates) => connectFirstLocal(provider, candidates)),
    Effect.catchAll((failure) => Effect.succeed({
      availability: Effect.succeed({
        status: "unavailable" as const,
        reason: failure.reason,
        cause: failure.cause,
        rejectedCandidates: failure.rejectedCandidates,
      }),
      identity: null,
      client: null,
      compatibility: APP_SERVER_COMPATIBILITY,
    })),
  );
}
