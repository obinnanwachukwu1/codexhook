import { Context, Effect, Layer, Scope } from "effect";
import { Logger } from "../logger.js";
import { discoverStandalone } from "./discovery.js";
import { desktopVisibilityCandidate } from "./desktop-endpoint.js";
import {
  TransportIncompatible,
  TransportUnavailable,
} from "./errors.js";
import { spawnChildPeer } from "./child-peer.js";
import type { AppServerPeer } from "./rpc.js";
import { connectUnixPeer } from "./unix-peer.js";
import type { AppServerTransportSpec } from "./spec.js";
export type { AppServerTransportSpec } from "./spec.js";

export interface TransportProviderService {
  /** Candidate set for the canonical local app-server plane only. */
  readonly appServerCandidates: Effect.Effect<
    ReadonlyArray<AppServerTransportSpec>
  >;
  readonly desktopCandidate: typeof desktopVisibilityCandidate;
  readonly connect: (
    spec: AppServerTransportSpec,
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
  return Layer.succeed(
    TransportProvider,
    TransportProvider.of({
      desktopCandidate: desktopVisibilityCandidate,
      appServerCandidates: Effect.promise(() => discoverStandalone()),
      connect: (spec) => spec._tag === "UnixSocket"
        ? connectUnixPeer(spec, logger)
        : spawnChildPeer(spec, logger),
    }),
  );
}
