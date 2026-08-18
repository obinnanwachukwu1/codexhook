import assert from "node:assert/strict";
import { chmod, symlink } from "node:fs/promises";
import test from "node:test";
import { desktopSocketIsPrivate } from "../src/transport/desktop-endpoint.js";
import {
  DesktopProtocolError,
  DesktopProtocolSession,
  isAbsentDesktopEndpointError,
} from "../src/transport/desktop-ipc/index.js";
import { listen, testEndpoint } from "./support/desktop-ipc-router.js";

test("only missing and refused endpoint errors prove Desktop absent", () => {
  const error = (code: string) => Object.assign(new Error(code), { code });
  assert.equal(isAbsentDesktopEndpointError(error("ENOENT")), true);
  assert.equal(isAbsentDesktopEndpointError(error("ECONNREFUSED")), true);
  assert.equal(isAbsentDesktopEndpointError(error("EACCES")), false);
  assert.equal(isAbsentDesktopEndpointError(error("EMFILE")), false);
  assert.equal(isAbsentDesktopEndpointError(error("ETIMEDOUT")), false);
});

test("Desktop endpoint privacy rejects exposed and symlinked sockets", async () => {
  if (process.platform === "win32") return;
  const endpoint = await testEndpoint();
  const router = await listen(endpoint.socketPath, null);
  const linkPath = `${endpoint.socketPath}.link`;
  try {
    await chmod(endpoint.socketPath, 0o600);
    assert.equal(await desktopSocketIsPrivate(endpoint.socketPath), true);
    await chmod(endpoint.socketPath, 0o666);
    assert.equal(await desktopSocketIsPrivate(endpoint.socketPath), false);
    await chmod(endpoint.socketPath, 0o600);
    await symlink(endpoint.socketPath, linkPath);
    assert.equal(await desktopSocketIsPrivate(linkPath), false);
  } finally {
    await router.close();
    await endpoint.cleanup();
  }
});

test("a missing Desktop endpoint is not private", async () => {
  const endpoint = await testEndpoint();
  try {
    if (process.platform !== "win32") {
      assert.equal(await desktopSocketIsPrivate(endpoint.socketPath), false);
    }
    await assert.rejects(
      DesktopProtocolSession.probe(endpoint.socketPath),
      (error: unknown) =>
        error instanceof DesktopProtocolError &&
        error.failure === "socket-unavailable",
    );
  } finally {
    await endpoint.cleanup();
  }
});
