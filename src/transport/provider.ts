import { Context, Effect, Layer, Option, Scope } from "effect";
import { Logger } from "../logger.js";
import { discoverStandalone } from "./discovery.js";
import { connectDesktop } from "./desktop.js";
import {
  desktopProbe,
  desktopVisibilityCandidate,
} from "./desktop-endpoint.js";
import {
  TransportIncompatible,
  TransportUnavailable,
} from "./errors.js";
import { spawnChildPeer } from "./child-peer.js";
import type { AppServerPeer } from "./rpc.js";
import { connectUnixPeer } from "./unix-peer.js";
import type { TransportSpec } from "./spec.js";

export interface TransportProviderService {
  readonly candidates: Effect.Effect<ReadonlyArray<TransportSpec>>;
  /** Candidate set for the canonical local app-server plane only. */
  readonly appServerCandidates: Effect.Effect<ReadonlyArray<TransportSpec>>;
  readonly desktopCandidate: typeof desktopVisibilityCandidate;
  readonly connect: (
    spec: TransportSpec,
  ) => Effect.Effect<
    AppServerPeer,
    TransportUnavailable | TransportIncompatible,
    Scope.Scope
  >;
}

export class TransportProvider extends Context.Tag(
  "codexhook/TransportProvider",
)<TransportProvider, TransportProviderService>() {}

export function TransportProviderLive(
  logger = new Logger(),
): Layer.Layer<TransportProvider> {
  return Layer.effect(
    TransportProvider,
    Effect.gen(function* () {
      const probeDesktop = yield* Effect.cachedWithTTL(
        desktopProbe,
        "2 seconds",
      );
      const appServerCandidates = Effect.promise(() => discoverStandalone());
      return TransportProvider.of({
        desktopCandidate: desktopVisibilityCandidate,
        appServerCandidates,
        candidates: Effect.gen(function* () {
          const desktop = yield* probeDesktop;
          const standalone = yield* appServerCandidates;
          return [...Option.toArray(desktop), ...standalone];
        }),
        connect: (spec) =>
          spec._tag === "Desktop"
            ? connectDesktop(spec)
            : spec._tag === "UnixSocket"
              ? connectUnixPeer(spec, logger)
              : spawnChildPeer(spec, logger),
      });
    }),
  );
}
