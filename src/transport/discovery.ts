import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import type { TransportSpec } from "./spec.js";

const DARWIN_BUNDLED_CODEX =
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
  platform: NodeJS.Platform,
): Promise<string | null> {
  const suffixes =
    platform === "win32"
      ? ["", ...(environment.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .map((value) => value.toLowerCase())]
      : [""];
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}

async function windowsBundledCodex(
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  const localAppData =
    environment.LOCALAPPDATA ??
    path.join(environment.USERPROFILE ?? os.homedir(), "AppData", "Local");
  const directory = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const candidates = await Promise.all(
      (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const executablePath = path.join(
            directory,
            entry.name,
            "codex.exe",
          );
          if (!(await executable(executablePath))) return null;
          return {
            executablePath,
            modified: (await stat(executablePath)).mtimeMs,
          };
        }),
    );
    return (
      candidates
        .filter((candidate) => candidate != null)
        .sort((left, right) => right.modified - left.modified)[0]
        ?.executablePath ?? null
    );
  } catch {
    return null;
  }
}

async function bundledCodex(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (platform === "darwin") {
    return (await executable(DARWIN_BUNDLED_CODEX))
      ? DARWIN_BUNDLED_CODEX
      : null;
  }
  return platform === "win32"
    ? windowsBundledCodex(environment)
    : null;
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
  platform: NodeJS.Platform = process.platform,
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
        shell: platform === "win32" && /\.(?:bat|cmd)$/i.test(explicit),
        coPresence: false,
        approvals: "decline",
      },
    ];
  }

  const specs: TransportSpec[] = [];
  const bundled = await bundledCodex(environment, platform);
  const cli = await commandOnPath("codex", environment, platform);
  const probeExecutable = cli ?? bundled;
  if (probeExecutable != null) {
    const daemon = await runningDaemon(probeExecutable);
    if (daemon != null) specs.push(daemon);
  }
  if (bundled != null) {
    specs.push({
      _tag: "ChildProcess",
      id: "app-bundled",
      executable: bundled,
      args: ["app-server", "--listen", "stdio://"],
      coPresence: false,
      approvals: "decline",
    });
  }
  if (cli != null && cli !== bundled) {
    specs.push({
      _tag: "ChildProcess",
      id: "cli",
      executable: cli,
      args: ["app-server", "--listen", "stdio://"],
      shell: platform === "win32" && /\.(?:bat|cmd)$/i.test(cli),
      coPresence: false,
      approvals: "decline",
    });
  }
  return specs;
}
