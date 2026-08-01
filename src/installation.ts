import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultBaseUrl, normalizeBaseUrl } from "./config.js";
import { VERSION } from "./version.js";

export const LAUNCH_LABEL = "dev.codexhook.daemon";

export interface InstallManifest {
  version: string;
  nodePath: string;
  baseUrl: string;
  dataDirectory: string;
  installedAt: string;
}

export interface InstallPaths {
  runtimeRoot: string;
  currentLink: string;
  manifest: string;
  shim: string;
  skill: string;
  launchAgent: string;
  log: string;
}

export function installationPaths(home = homedir()): InstallPaths {
  const runtimeRoot = path.join(home, ".local", "share", "codexhook");
  return {
    runtimeRoot,
    currentLink: path.join(runtimeRoot, "current"),
    manifest: path.join(runtimeRoot, "install.json"),
    shim: path.join(home, ".local", "bin", "codexhook"),
    skill: path.join(home, ".codex", "skills", "codexhook"),
    launchAgent: path.join(
      home,
      "Library",
      "LaunchAgents",
      `${LAUNCH_LABEL}.plist`,
    ),
    log: path.join(home, ".codexhook", "log", "daemon.log"),
  };
}

export function readInstallManifest(
  paths = installationPaths(),
): InstallManifest | null {
  try {
    const value = JSON.parse(readFileSync(paths.manifest, "utf8")) as Partial<
      InstallManifest
    >;
    if (
      typeof value.version !== "string" ||
      typeof value.nodePath !== "string" ||
      typeof value.baseUrl !== "string" ||
      typeof value.dataDirectory !== "string" ||
      typeof value.installedAt !== "string"
    ) {
      return null;
    }
    return value as InstallManifest;
  } catch {
    return null;
  }
}

function atomicWrite(filename: string, contents: string, mode: number): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode });
  renameSync(temporary, filename);
}

function replaceSymlink(target: string, link: string): void {
  mkdirSync(path.dirname(link), { recursive: true });
  const temporary = `${link}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgent(
  paths: InstallPaths,
  nodePath: string,
  environmentPath: string,
  dataDirectory = path.dirname(path.dirname(paths.log)),
): string {
  const runtime = path.join(paths.currentLink, "codexhook.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(runtime)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(environmentPath)}</string>
    <key>CODEXHOOK_HOME</key><string>${xml(dataDirectory)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict>
</plist>
`;
}

function locateRuntime(entrypoint = process.argv[1]): string {
  if (entrypoint == null) throw new Error("cannot locate the packaged runtime");
  const requested = path.resolve(entrypoint);
  const resolved = existsSync(requested) ? realpathSync(requested) : requested;
  const candidates = [
    resolved,
    path.join(path.dirname(resolved), "..", "codexhook.mjs"),
  ];
  const runtime = candidates.find(
    (candidate) =>
      existsSync(candidate) && path.basename(candidate) === "codexhook.mjs",
  );
  if (runtime == null) {
    throw new Error(
      "packaged runtime is missing; run setup from the published npm package",
    );
  }
  return runtime;
}

function locateSkill(runtime: string): string {
  const directory = path.dirname(runtime);
  const candidates = [
    path.join(directory, "skill"),
    path.join(directory, "..", "skills", "codexhook"),
    path.join(directory, "..", "..", "skills", "codexhook"),
  ];
  const skill = candidates.find((candidate) =>
    existsSync(path.join(candidate, "SKILL.md")),
  );
  if (skill == null) throw new Error("packaged Codex skill is missing");
  return skill;
}

function launchctl(
  arguments_: string[],
  options: { ignoreFailure?: boolean } = {},
): void {
  try {
    execFileSync("/bin/launchctl", arguments_, { stdio: "pipe" });
  } catch (error) {
    if (!options.ignoreFailure) {
      const detail =
        error instanceof Error && "stderr" in error
          ? String(error.stderr).trim()
          : String(error);
      throw new Error(`launchctl ${arguments_[0]} failed: ${detail}`);
    }
  }
}

function userId(): number {
  if (process.getuid == null) {
    throw new Error("launchd user services require a Unix user id");
  }
  return process.getuid();
}

export function kickstartLaunchAgent(): void {
  launchctl([
    "kickstart",
    "-k",
    `gui/${userId()}/${LAUNCH_LABEL}`,
  ]);
}

function loadLaunchAgent(paths: InstallPaths): void {
  const domain = `gui/${userId()}`;
  launchctl(["bootout", domain, paths.launchAgent], { ignoreFailure: true });
  launchctl(["bootstrap", domain, paths.launchAgent]);
  kickstartLaunchAgent();
}

function pruneVersions(paths: InstallPaths, keep: number): void {
  const protectedNames = new Set(["current", "install.json"]);
  const currentTarget = readlinkSync(paths.currentLink);
  const currentName = path.basename(currentTarget);
  const versions = readdirSync(paths.runtimeRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !protectedNames.has(entry.name) &&
        entry.name !== currentName,
    )
    .map((entry) => ({
      name: entry.name,
      modified: lstatSync(path.join(paths.runtimeRoot, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.modified - left.modified);
  for (const stale of versions.slice(Math.max(0, keep - 1))) {
    rmSync(path.join(paths.runtimeRoot, stale.name), {
      recursive: true,
      force: true,
    });
  }
}

export interface SetupOptions {
  baseUrl?: string | undefined;
  home?: string | undefined;
  runtimeSource?: string | undefined;
  skillSource?: string | undefined;
  activate?: boolean | undefined;
}

export function setupInstallation(options: SetupOptions = {}): InstallManifest {
  if (process.platform !== "darwin" && options.activate !== false) {
    throw new Error("v1 background installation supports macOS only");
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error("Node.js 24 or newer is required");
  }

  const paths = installationPaths(options.home);
  const previous = readInstallManifest(paths);
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? previous?.baseUrl ?? defaultBaseUrl(),
  ).toString().replace(/\/$/, "");
  const runtimeSource = options.runtimeSource ?? locateRuntime();
  const skillSource = options.skillSource ?? locateSkill(runtimeSource);
  const versionDirectory = path.join(paths.runtimeRoot, VERSION);
  const runtimeTarget = path.join(versionDirectory, "codexhook.mjs");
  const versionSkill = path.join(versionDirectory, "skill");

  mkdirSync(versionDirectory, { recursive: true, mode: 0o700 });
  if (path.resolve(runtimeSource) !== path.resolve(runtimeTarget)) {
    const temporaryRuntime = `${runtimeTarget}.tmp-${process.pid}`;
    copyFileSync(runtimeSource, temporaryRuntime);
    chmodSync(temporaryRuntime, 0o755);
    renameSync(temporaryRuntime, runtimeTarget);
  }
  chmodSync(runtimeTarget, 0o755);
  if (path.resolve(skillSource) !== path.resolve(versionSkill)) {
    rmSync(versionSkill, { recursive: true, force: true });
    cpSync(skillSource, versionSkill, { recursive: true });
  }
  replaceSymlink(versionDirectory, paths.currentLink);
  replaceSymlink(
    path.join(paths.currentLink, "codexhook.mjs"),
    paths.shim,
  );
  rmSync(paths.skill, { recursive: true, force: true });
  mkdirSync(path.dirname(paths.skill), { recursive: true });
  cpSync(versionSkill, paths.skill, { recursive: true });
  mkdirSync(path.dirname(paths.log), { recursive: true, mode: 0o700 });

  const manifest: InstallManifest = {
    version: VERSION,
    nodePath: process.execPath,
    baseUrl,
    dataDirectory:
      process.env.CODEXHOOK_HOME ??
      path.join(options.home ?? homedir(), ".codexhook"),
    installedAt: new Date().toISOString(),
  };
  atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  const environmentPath = [
    path.dirname(process.execPath),
    process.env.PATH ?? "",
  ].filter(Boolean).join(path.delimiter);
  atomicWrite(
    paths.launchAgent,
    renderLaunchAgent(
      paths,
      process.execPath,
      environmentPath,
      manifest.dataDirectory,
    ),
    0o600,
  );
  pruneVersions(paths, 2);
  if (options.activate !== false) loadLaunchAgent(paths);
  return manifest;
}

export function uninstallInstallation(
  options: {
    home?: string | undefined;
    purge?: boolean | undefined;
    purgeDataDirectory?: string | undefined;
  } = {},
): void {
  const paths = installationPaths(options.home);
  const manifest = readInstallManifest(paths);
  if (process.platform === "darwin") {
    launchctl(
      [
        "bootout",
        `gui/${userId()}`,
        paths.launchAgent,
      ],
      { ignoreFailure: true },
    );
  }
  rmSync(paths.launchAgent, { force: true });
  rmSync(paths.shim, { force: true });
  rmSync(paths.skill, { recursive: true, force: true });
  rmSync(paths.runtimeRoot, { recursive: true, force: true });
  if (options.purge === true) {
    rmSync(
      options.purgeDataDirectory ??
        manifest?.dataDirectory ??
        path.join(options.home ?? homedir(), ".codexhook"),
      {
      recursive: true,
      force: true,
      },
    );
  }
}

export function installedRuntimePath(paths = installationPaths()): string | null {
  try {
    const target = readlinkSync(paths.currentLink);
    const directory = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(paths.currentLink), target);
    return path.join(directory, "codexhook.mjs");
  } catch {
    return null;
  }
}
