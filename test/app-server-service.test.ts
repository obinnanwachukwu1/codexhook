import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, Option } from "effect";
import {
  CanonicalAppServer,
  CanonicalAppServerLive,
} from "../src/app-server/service.js";
import {
  TransportProvider,
  type TransportProviderService,
} from "../src/transport/provider.js";
import type { TransportSpec } from "../src/transport/spec.js";
import { fakeAppServerPeer } from "./support/app-server-fixture.js";

const first: TransportSpec = {
  _tag: "ChildProcess",
  id: "app-bundled",
  executable: "/fake/first",
  args: [],
  approvals: "decline",
};
const second: TransportSpec = {
  _tag: "ChildProcess",
  id: "cli",
  executable: "/fake/second",
  args: [],
  approvals: "decline",
};

test("closes a rejected candidate before connecting the next", async () => {
  let live = 0;
  let maxLive = 0;
  const rejected = fakeAppServerPeer(() => ({}), {
    spec: first,
    serverInfo: null,
  }).peer;
  const accepted = fakeAppServerPeer(() => ({}), {
    spec: second,
    serverInfo: {
      userAgent: "codex",
      codexHome: "/Users/user/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
  }).peer;
  const provider: TransportProviderService = {
    candidates: Effect.succeed([first, second]),
    desktopCandidate: Effect.succeed(Option.none()),
    connect: (spec) => Effect.acquireRelease(
      Effect.sync(() => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        return spec.id === first.id ? rejected : accepted;
      }),
      () => Effect.sync(() => {
        live -= 1;
      }),
    ),
  };
  const layer = CanonicalAppServerLive.pipe(
    Layer.provide(Layer.succeed(TransportProvider, provider)),
  );
  const identity = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* CanonicalAppServer;
      assert.equal(live, 1);
      return service.identity;
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(identity.transport, "cli");
  assert.equal(maxLive, 1);
  assert.equal(live, 0);
});
