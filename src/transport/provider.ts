import { Context, Effect, Layer, Option, Scope } from "effect";
import { Logger } from "../logger.js";
import {
  NO_DIAGNOSTICS,
  type DiagnosticObserver,
} from "../diagnostics/contracts.js";
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
  diagnostics: DiagnosticObserver = NO_DIAGNOSTICS,
): Layer.Layer<TransportProvider> {
  return Layer.effect(
    TransportProvider,
    Effect.gen(function* () {
      const probeDesktop = yield* Effect.cachedWithTTL(
        desktopProbe,
        "2 seconds",
      );
      return TransportProvider.of({
        desktopCandidate: desktopVisibilityCandidate,
        candidates: Effect.gen(function* () {
          const desktop = yield* probeDesktop;
          const standalone = yield* Effect.promise(() =>
            discoverStandalone(),
          );
          return [...Option.toArray(desktop), ...standalone];
        }),
        connect: (spec) =>
          spec._tag === "Desktop"
            ? connectDesktop(spec, diagnostics)
            : spec._tag === "UnixSocket"
              ? connectUnixPeer(spec, logger)
              : spawnChildPeer(spec, logger),
      });
    }),
  );
}
