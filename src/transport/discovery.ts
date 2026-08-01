import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { TransportSpec } from "./spec.js";

const DEFAULT_BUNDLED_CODEX =
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const execFileAsync = promisify(execFile);

async function executable(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandOnPath(
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

interface DaemonVersion {
  status?: string;
  socketPath?: string;
}

async function runningDaemon(
  codexExecutable: string,
): Promise<TransportSpec | null> {
  try {
    const { stdout } = await execFileAsync(
      codexExecutable,
      ["app-server", "daemon", "version"],
      { timeout: 2_000, maxBuffer: 64 * 1_024 },
    );
    const result = JSON.parse(stdout) as DaemonVersion;
    if (
      result.status !== "running" ||
      result.socketPath == null ||
      !(await executableFile(result.socketPath))
    ) {
      return null;
    }
    return {
      _tag: "UnixSocket",
      id: "daemon",
      socketPath: result.socketPath,
      // The daemon is shared and persistent, but this does not promise that
      // the Desktop UI is one of its connected clients.
      coPresence: false,
      approvals: "decline",
    };
  } catch {
    return null;
  }
}

async function executableFile(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverStandalone(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyArray<TransportSpec>> {
  const explicit = environment.CODEXHOOK_CODEX_PATH;
  if (explicit != null && explicit.length > 0) {
    if (!(await executable(explicit))) return [];
    const daemon = await runningDaemon(explicit);
    return [
      ...(daemon == null ? [] : [daemon]),
      {
        _tag: "ChildProcess",
        id: "cli",
        executable: explicit,
        args: ["app-server", "--listen", "stdio://"],
        coPresence: false,
        approvals: "decline",
      },
    ];
  }

  const specs: TransportSpec[] = [];
  const bundledAvailable = await executable(DEFAULT_BUNDLED_CODEX);
  const cli = await commandOnPath("codex", environment);
  const probeExecutable = cli ?? (bundledAvailable ? DEFAULT_BUNDLED_CODEX : null);
  if (probeExecutable != null) {
    const daemon = await runningDaemon(probeExecutable);
    if (daemon != null) specs.push(daemon);
  }
  if (bundledAvailable) {
    specs.push({
      _tag: "ChildProcess",
      id: "app-bundled",
      executable: DEFAULT_BUNDLED_CODEX,
      args: ["app-server", "--listen", "stdio://"],
      coPresence: false,
      approvals: "decline",
    });
  }
  if (cli != null && cli !== DEFAULT_BUNDLED_CODEX) {
    specs.push({
      _tag: "ChildProcess",
      id: "cli",
      executable: cli,
      args: ["app-server", "--listen", "stdio://"],
      coPresence: false,
      approvals: "decline",
    });
  }
  return specs;
}
