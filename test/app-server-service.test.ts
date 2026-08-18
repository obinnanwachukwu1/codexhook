import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  CanonicalAppServer,
  CanonicalAppServerLive,
  localCodexHome,
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

function localServerInfo() {
  return {
    userAgent: "codex",
    codexHome: localCodexHome(),
    platformFamily: process.platform === "win32" ? "windows" : "unix",
    platformOs: process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform,
  };
}

test("closes a rejected candidate before connecting the next", async () => {
  let live = 0;
  let maxLive = 0;
  const rejected = fakeAppServerPeer(() => ({}), {
    spec: first,
    serverInfo: null,
  }).peer;
  const accepted = fakeAppServerPeer(() => ({}), {
    spec: second,
    serverInfo: localServerInfo(),
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
  assert.equal(identity?.transport, "cli");
  assert.equal(maxLive, 1);
  assert.equal(live, 0);
});

test("represents missing local app-server candidates as availability", async () => {
  const provider: TransportProviderService = {
    candidates: Effect.succeed([]),
    desktopCandidate: Effect.succeed(Option.none()),
    connect: () => Effect.die("unexpected connect"),
  };
  const layer = CanonicalAppServerLive.pipe(
    Layer.provide(Layer.succeed(TransportProvider, provider)),
  );
  const service = await Effect.runPromise(
    CanonicalAppServer.pipe(Effect.provide(layer)),
  );
  assert.equal(service.identity, null);
  assert.equal(service.client, null);
  assert.deepEqual(await Effect.runPromise(service.availability), {
    status: "unavailable",
    reason: "no-local-app-server",
    cause: "no-candidate",
    rejectedCandidates: [],
  });
});

test("reports every rejected canonical candidate without free text", async () => {
  const provider: TransportProviderService = {
    candidates: Effect.succeed([first, second]),
    desktopCandidate: Effect.succeed(Option.none()),
    connect: (spec) => Effect.succeed(
      fakeAppServerPeer(() => ({}), { spec, serverInfo: null }).peer,
    ),
  };
  const layer = CanonicalAppServerLive.pipe(
    Layer.provide(Layer.succeed(TransportProvider, provider)),
  );
  const service = await Effect.runPromise(
    CanonicalAppServer.pipe(Effect.provide(layer)),
  );
  assert.deepEqual(await Effect.runPromise(service.availability), {
    status: "unavailable",
    reason: "no-local-app-server",
    cause: "candidates-rejected",
    rejectedCandidates: ["app-bundled", "cli"],
  });
});

test("does not misclassify provider defects as unavailable candidates", async () => {
  const provider: TransportProviderService = {
    candidates: Effect.succeed([first]),
    desktopCandidate: Effect.succeed(Option.none()),
    connect: () => Effect.die("provider defect"),
  };
  const layer = CanonicalAppServerLive.pipe(
    Layer.provide(Layer.succeed(TransportProvider, provider)),
  );
  const exit = await Effect.runPromiseExit(
    CanonicalAppServer.pipe(Effect.provide(layer)),
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.equal(Cause.pretty(exit.cause).includes("provider defect"), true);
  }
});

test("rejects remote specs before provider connection", async () => {
  let connections = 0;
  const remotePipe: TransportSpec = {
    _tag: "UnixSocket",
    id: "daemon",
    socketPath: "\\\\remote-host\\pipe\\codex",
    approvals: "decline",
  };
  const remoteCodeMode: TransportSpec = {
    _tag: "ChildProcess",
    id: "cli",
    executable: "/fake/codex",
    args: ["app-server", "--code-mode-host=wss://remote.invalid"],
    approvals: "decline",
  };
  const provider: TransportProviderService = {
    candidates: Effect.succeed([remotePipe, remoteCodeMode]),
    desktopCandidate: Effect.succeed(Option.none()),
    connect: () => Effect.sync(() => {
      connections += 1;
      return fakeAppServerPeer(() => ({})).peer;
    }),
  };
  const layer = CanonicalAppServerLive.pipe(
    Layer.provide(Layer.succeed(TransportProvider, provider)),
  );
  const service = await Effect.runPromise(
    CanonicalAppServer.pipe(Effect.provide(layer)),
  );
  assert.equal(connections, 0);
  assert.deepEqual(await Effect.runPromise(service.availability), {
    status: "unavailable",
    reason: "no-local-app-server",
    cause: "candidates-rejected",
    rejectedCandidates: ["daemon", "cli"],
  });
});
