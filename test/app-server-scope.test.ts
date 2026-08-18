import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import { CanonicalPlaneUnavailable } from "../src/app-server/errors.js";
import { confirmLocalPlane } from "../src/app-server/service.js";
import { fakeAppServerPeer as fakePeer } from "./support/app-server-fixture.js";

test("requires matching local initialize provenance", async () => {
  const local = fakePeer(() => ({}));
  const service = await Effect.runPromise(
    confirmLocalPlane(local.peer, "linux", "/home/user/.codex"),
  );
  assert.equal(service.identity?.scope, "local-machine");
  assert.equal(service.identity?.provenance, "confirmed");
  assert.equal(service.compatibility.protocolFamily, "codex-app-server/v2");
  local.setAlive(false);
  assert.deepEqual(await Effect.runPromise(service.availability), {
    status: "unavailable",
    reason: "disconnected",
  });

  const mismatch = fakePeer(() => ({}), {
    serverInfo: {
      userAgent: "codex",
      codexHome: "/home/user/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
  const mismatchExit = await Effect.runPromiseExit(
    confirmLocalPlane(mismatch.peer, "linux", "/home/user/.codex"),
  );
  assert.equal(Exit.isFailure(mismatchExit), true);
  if (Exit.isFailure(mismatchExit)) {
    const failure = Cause.failureOption(mismatchExit.cause);
    assert.equal(
      Option.isSome(failure) &&
        failure.value instanceof CanonicalPlaneUnavailable &&
        failure.value.reason === "scope-mismatch",
      true,
    );
  }

  const remote = fakePeer(() => ({}), {
    spec: {
      _tag: "ChildProcess",
      id: "cli",
      executable: "/usr/bin/codex",
      args: ["app-server", "--code-mode-host=wss://remote.invalid"],
      approvals: "decline",
    },
  });
  const remoteFailure = await Effect.runPromise(Effect.flip(
    confirmLocalPlane(remote.peer, "linux", "/home/user/.codex"),
  ));
  assert.equal(remoteFailure.cause, "remote-code-mode-host");

  const bareRemote = fakePeer(() => ({}), {
    spec: {
      _tag: "ChildProcess",
      id: "cli",
      executable: "/usr/bin/codex",
      args: ["app-server", "--code-mode-host", "remote"],
      approvals: "decline",
    },
  });
  const bareRemoteFailure = await Effect.runPromise(Effect.flip(
    confirmLocalPlane(bareRemote.peer, "linux", "/home/user/.codex"),
  ));
  assert.equal(bareRemoteFailure.cause, "remote-code-mode-host");

  const wrongStore = fakePeer(() => ({}), {
    serverInfo: {
      userAgent: "codex",
      codexHome: "/home/other/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
  });
  const storeFailure = await Effect.runPromise(Effect.flip(
    confirmLocalPlane(wrongStore.peer, "linux", "/home/user/.codex"),
  ));
  assert.equal(storeFailure.cause, "store-mismatch");
});

test("rejects Desktop as a canonical enumeration plane", async () => {
  const fixture = fakePeer(() => ({}), {
    spec: {
      _tag: "Desktop",
      id: "desktop",
      socketPath: "/tmp/desktop.sock",
      approvals: "decline",
    },
  });
  const failure = await Effect.runPromise(Effect.flip(
    confirmLocalPlane(fixture.peer, "linux", "/home/user/.codex"),
  ));
  assert.equal(failure.cause, "desktop-plane");
});

test("accepts local platform metadata on every supported OS", async () => {
  const cases = [
    ["linux", "unix", "linux", "/home/user/.codex"],
    ["darwin", "unix", "macos", "/Users/user/.codex"],
    ["win32", "windows", "windows", "C:\\Users\\user\\.codex"],
  ] as const;
  for (const [platform, family, os, codexHome] of cases) {
    const fixture = fakePeer(() => ({}), {
      serverInfo: {
        userAgent: "codex",
        codexHome,
        platformFamily: family,
        platformOs: os,
      },
    });
    const service = await Effect.runPromise(
      confirmLocalPlane(fixture.peer, platform, codexHome),
    );
    assert.equal(service.identity?.platformOs, os);
  }
});

test("rejects remote Windows named-pipe paths", async () => {
  const fixture = fakePeer(() => ({}), {
    spec: {
      _tag: "UnixSocket",
      id: "daemon",
      socketPath: "\\\\remote-host\\pipe\\codex",
      approvals: "decline",
    },
    serverInfo: {
      userAgent: "codex",
      codexHome: "C:\\Users\\user\\.codex",
      platformFamily: "windows",
      platformOs: "windows",
    },
  });
  const failure = await Effect.runPromise(Effect.flip(
    confirmLocalPlane(fixture.peer, "win32", "C:\\Users\\user\\.codex"),
  ));
  assert.equal(failure.cause, "non-local-socket");
});

test("accepts local Windows AF_UNIX paths", async () => {
  const fixture = fakePeer(() => ({}), {
    spec: {
      _tag: "UnixSocket",
      id: "daemon",
      socketPath: "C:\\Users\\user\\codex.sock",
      approvals: "decline",
    },
    serverInfo: {
      userAgent: "codex",
      codexHome: "C:\\Users\\user\\.codex",
      platformFamily: "windows",
      platformOs: "windows",
    },
  });
  const service = await Effect.runPromise(
    confirmLocalPlane(fixture.peer, "win32", "C:\\Users\\user\\.codex"),
  );
  assert.equal(service.identity?.transport, "daemon");
});
