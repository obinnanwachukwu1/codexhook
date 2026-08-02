import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { discoverStandalone } from "../src/transport/discovery.js";

const execFileAsync = promisify(execFile);

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

test("wraps Windows command shims with an explicitly quoted command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhook-path-"));
  const shim = path.join(root, "codex.cmd");
  await executable(shim, 1);

  const specs = await discoverStandalone(
    {
      LOCALAPPDATA: path.join(root, "missing"),
      PATH: root,
      PATHEXT: ".EXE;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
    "win32",
  );

  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0], {
    _tag: "ChildProcess",
    id: "cli",
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `""${shim}" "app-server" "--listen" "stdio://""`,
    ],
    windowsVerbatimArguments: true,
    coPresence: false,
    approvals: "decline",
  });
});

test(
  "runs a Windows command shim whose path contains spaces",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "codexhook path with spaces-"),
    );
    const shim = path.join(root, "codex.cmd");
    await writeFile(shim, "@echo %*\r\n");
    const specs = await discoverStandalone(
      {
        LOCALAPPDATA: path.join(root, "missing"),
        PATH: root,
        PATHEXT: ".CMD",
        ComSpec: process.env.ComSpec,
      },
      "win32",
    );
    const child = specs.find((candidate) => candidate._tag === "ChildProcess");
    assert.ok(child != null && child._tag === "ChildProcess");
    const { stdout } = await execFileAsync(
      child.executable,
      [...child.args],
      {
        windowsVerbatimArguments:
          child.windowsVerbatimArguments ?? false,
      },
    );
    assert.match(stdout, /app-server --listen stdio:\/\//);
  },
);
