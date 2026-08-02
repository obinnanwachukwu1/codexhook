import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverStandalone } from "../src/transport/discovery.js";

async function executable(filename: string, modified: number): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, "");
  await chmod(filename, 0o755);
  await utimes(filename, modified, modified);
}

test("discovers the newest Windows Codex runtime installed by the app", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhook-discovery-"));
  const bin = path.join(root, "OpenAI", "Codex", "bin");
  const older = path.join(bin, "older", "codex.exe");
  const newer = path.join(bin, "newer", "codex.exe");
  await executable(older, 1);
  await executable(newer, 2);

  const specs = await discoverStandalone(
    { LOCALAPPDATA: root, PATH: "" },
    "win32",
  );

  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0], {
    _tag: "ChildProcess",
    id: "app-bundled",
    executable: newer,
    args: ["app-server", "--listen", "stdio://"],
    coPresence: false,
    approvals: "decline",
  });
});

test("discovers Windows command shims with shell execution enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhook-path-"));
  const shim = path.join(root, "codex.cmd");
  await executable(shim, 1);

  const specs = await discoverStandalone(
    {
      LOCALAPPDATA: path.join(root, "missing"),
      PATH: root,
      PATHEXT: ".EXE;.CMD",
    },
    "win32",
  );

  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0], {
    _tag: "ChildProcess",
    id: "cli",
    executable: shim,
    args: ["app-server", "--listen", "stdio://"],
    shell: true,
    coPresence: false,
    approvals: "decline",
  });
});
