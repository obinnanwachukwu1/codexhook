import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Option } from "effect";
import {
  desktopOffer,
  desktopProtocolService,
} from "../src/transport/desktop-contract.js";
import type { DesktopProtocolProfile } from "../src/transport/desktop-ipc/index.js";
import type { TransportProviderService } from "../src/transport/provider.js";
import { TransportIncompatible } from "../src/transport/errors.js";

function profile(
  capabilities: DesktopProtocolProfile["capabilities"],
): DesktopProtocolProfile {
  return {
    compatibility: { major: 1, revision: 1 },
    capabilities,
    fingerprint: {
      adapterId: "desktop-ipc/v1",
      appVersion: null,
      buildNumber: null,
      digest: "opaque",
      protocolVersion: 1,
    },
  };
}

test("maps negotiated adapter compatibility and capabilities once", () => {
  const offer = desktopOffer(profile({
    source: "advertised",
    completeHistory: true,
    startTurn: true,
    steerTurn: true,
    threadStream: true,
  }));
  assert.deepEqual(offer, {
    plane: "desktop-ipc",
    major: 1,
    revision: 1,
    features: [
      "task-follow",
      "task-events",
      "task-history",
      "turn-start",
      "turn-steer",
      "delivery-id",
    ],
  });

  const missingSteer = desktopOffer(profile({
    source: "advertised",
    completeHistory: true,
    startTurn: true,
    steerTurn: false,
    threadStream: true,
  }));
  assert.equal(missingSteer.features.includes("turn-steer"), false);
  assert.equal(missingSteer.features.includes("delivery-id"), false);
});

test("reports an absent Desktop without opening a connection", async () => {
  let connects = 0;
  const provider: TransportProviderService = {
    candidates: Effect.succeed([]),
    appServerCandidates: Effect.succeed([]),
    desktopCandidate: Effect.succeed(Option.none()),
    connect: () => {
      connects += 1;
      return Effect.die("unexpected connection");
    },
  };
  const service = desktopProtocolService(provider);
  assert.deepEqual(await Effect.runPromise(service.availability), {
    status: "unavailable",
    diagnostic: {
      code: "desktop-unavailable",
      stage: "probe-desktop",
      route: "desktop",
    },
  });
  const exit = await Effect.runPromiseExit(Effect.scoped(service.connect));
  assert.equal(Exit.isFailure(exit), true);
  assert.equal(connects, 0);
});

test("reports provider discovery failures as unavailable, not incompatible", async () => {
  const provider: TransportProviderService = {
    candidates: Effect.succeed([]),
    appServerCandidates: Effect.succeed([]),
    desktopCandidate: Effect.fail(new TransportIncompatible({
      transport: "desktop",
      stage: "capabilities",
      detail: "private path detail must not escape",
    })),
    connect: () => Effect.die("not used"),
  };
  assert.deepEqual(
    await Effect.runPromise(desktopProtocolService(provider).availability),
    {
      status: "unavailable",
      diagnostic: {
        code: "desktop-unavailable",
        stage: "probe-desktop",
        route: "desktop",
      },
    },
  );
});
