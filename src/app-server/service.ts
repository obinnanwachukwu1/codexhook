import path from "node:path";
import { Context, Effect, Layer, Scope } from "effect";
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
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
  readonly userAgent: string;
}

export interface CanonicalAppServerService {
  readonly availability: "available";
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
      peer.spec.args.includes("--code-mode-host")
    ) {
      return yield* new CanonicalPlaneUnavailable({
        reason: "scope-mismatch",
        detail: "remote code-mode app-server targets are not supported",
      });
    }
    if (
      peer.spec._tag === "UnixSocket" &&
      !absoluteForPlatform(peer.spec.socketPath, platform)
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
        detail:
          `app-server reports ${info.platformFamily}/${info.platformOs}; ` +
          `local machine is ${expected.family}/${expected.os}`,
      });
    }
    return {
      availability: "available",
      identity: {
        scope: "local-machine",
        provenance: "confirmed",
        transport: peer.spec.id,
        codexHome: info.codexHome,
        platformFamily: info.platformFamily,
        platformOs: info.platformOs,
        userAgent: info.userAgent,
      },
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
          : failures.join("; "),
      }),
    );
  }
  return provider.connect(candidate).pipe(
    Effect.flatMap((peer) => confirmLocalPlane(peer)),
    Effect.catchAll((error) =>
      connectFirstLocal(provider, rest, [
        ...failures,
        `${candidate.id}: ${"detail" in error ? String(error.detail) : String(error)}`,
      ]),
    ),
  );
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
