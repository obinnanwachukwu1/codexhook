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
import {
  type BackgroundServiceConfig,
  installBackgroundService,
  removeBackgroundService,
  renderLaunchAgent as renderMacLaunchAgent,
  renderSystemdService,
  renderWindowsService,
  SERVICE_NAME,
  startBackgroundService,
} from "./background-service.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultBaseUrl,
  normalizeBaseUrl,
} from "./config.js";
import { VERSION } from "./version.js";

export const LAUNCH_LABEL = SERVICE_NAME;

export interface InstallManifest {
  version: string;
  nodePath: string;
  baseUrl: string;
  port: number;
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

export function installationPaths(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): InstallPaths {
  const runtimeRoot = path.join(home, ".local", "share", "codexhook");
  const service =
    platform === "darwin"
      ? path.join(
          home,
          "Library",
          "LaunchAgents",
          `${LAUNCH_LABEL}.plist`,
        )
      : platform === "linux"
        ? path.join(home, ".config", "systemd", "user", "codexhook.service")
        : path.join(runtimeRoot, "codexhook-service.cmd");
  return {
    runtimeRoot,
    currentLink: path.join(runtimeRoot, "current"),
    manifest: path.join(runtimeRoot, "install.json"),
    shim: path.join(
      home,
      ".local",
      "bin",
      platform === "win32" ? "codexhook.cmd" : "codexhook",
    ),
    skill: path.join(home, ".codex", "skills", "codexhook"),
    launchAgent: service,
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
    const port = value.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { ...value, port } as InstallManifest;
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

export function renderLaunchAgent(
  paths: InstallPaths,
  nodePath: string,
  environmentPath: string,
  dataDirectory = path.dirname(path.dirname(paths.log)),
  port = DEFAULT_PORT,
): string {
  return renderMacLaunchAgent(
    {
      definition: paths.launchAgent,
      runtime: path.join(paths.currentLink, "codexhook.mjs"),
      log: paths.log,
      nodePath,
      dataDirectory,
      environmentPath,
      port,
    },
  );
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

export function installationServicePaths(paths: InstallPaths) {
  return {
    definition: paths.launchAgent,
    runtime: path.join(paths.currentLink, "codexhook.mjs"),
    log: paths.log,
  };
}

export function kickstartLaunchAgent(
  paths = installationPaths(),
): void {
  startBackgroundService(installationServicePaths(paths));
}

function pruneVersions(
  paths: InstallPaths,
  keep: number,
  platform: NodeJS.Platform,
): void {
  const protectedNames = new Set(["current", "install.json"]);
  const currentName =
    platform === "win32"
      ? null
      : path.basename(readlinkSync(paths.currentLink));
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
  const retainedVersions =
    platform === "win32" ? keep : Math.max(0, keep - 1);
  for (const stale of versions.slice(retainedVersions)) {
    rmSync(path.join(paths.runtimeRoot, stale.name), {
      recursive: true,
      force: true,
    });
  }
}

export interface SetupOptions {
  baseUrl?: string | undefined;
  port?: number | undefined;
  home?: string | undefined;
  runtimeSource?: string | undefined;
  skillSource?: string | undefined;
  activate?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
}

export function setupInstallation(options: SetupOptions = {}): InstallManifest {
  const platform = options.platform ?? process.platform;
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`background installation is unsupported on ${platform}`);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error("Node.js 24 or newer is required");
  }

  const paths = installationPaths(options.home, platform);
  const previous = readInstallManifest(paths);
  const port = options.port ?? previous?.port ?? DEFAULT_PORT;
  const previousLocalUrl =
    previous == null
      ? null
      : defaultBaseUrl(DEFAULT_HOST, previous.port);
  const preservedBaseUrl =
    previous?.baseUrl === previousLocalUrl ? undefined : previous?.baseUrl;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ??
      preservedBaseUrl ??
      defaultBaseUrl(DEFAULT_HOST, port),
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
  if (platform === "win32") {
    rmSync(paths.currentLink, { recursive: true, force: true });
    cpSync(versionDirectory, paths.currentLink, { recursive: true });
    atomicWrite(
      paths.shim,
      `@set "CODEXHOOK_LAUNCHER=%~f0" & "${process.execPath}" "${path.join(paths.currentLink, "codexhook.mjs")}" %* & if /i "%~1"=="uninstall" ((goto) 2>nul & del "%~f0")\r\n`,
      0o755,
    );
  } else {
    replaceSymlink(versionDirectory, paths.currentLink);
    replaceSymlink(
      path.join(paths.currentLink, "codexhook.mjs"),
      paths.shim,
    );
  }
  rmSync(paths.skill, { recursive: true, force: true });
  mkdirSync(path.dirname(paths.skill), { recursive: true });
  cpSync(versionSkill, paths.skill, { recursive: true });
  mkdirSync(path.dirname(paths.log), { recursive: true, mode: 0o700 });

  const manifest: InstallManifest = {
    version: VERSION,
    nodePath: process.execPath,
    baseUrl,
    port,
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
  const backgroundConfig: BackgroundServiceConfig = {
    ...installationServicePaths(paths),
    nodePath: process.execPath,
    dataDirectory: manifest.dataDirectory,
    environmentPath,
    port: manifest.port,
  };
  const serviceDefinition =
    platform === "darwin"
      ? renderMacLaunchAgent(backgroundConfig)
      : platform === "linux"
        ? renderSystemdService(backgroundConfig)
        : renderWindowsService(backgroundConfig);
  atomicWrite(paths.launchAgent, serviceDefinition, 0o600);
  pruneVersions(paths, 2, platform);
  if (options.activate !== false) {
    installBackgroundService(installationServicePaths(paths), platform);
  }
  return manifest;
}

export function uninstallInstallation(
  options: {
    home?: string | undefined;
    purge?: boolean | undefined;
    purgeDataDirectory?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    deactivate?: boolean | undefined;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const paths = installationPaths(options.home, platform);
  const manifest = readInstallManifest(paths);
  if (options.deactivate !== false) {
    removeBackgroundService(installationServicePaths(paths), platform);
  }
  rmSync(paths.launchAgent, { force: true });
  const activeWindowsLauncher =
    platform === "win32" &&
    process.env.CODEXHOOK_LAUNCHER?.toLowerCase() ===
      paths.shim.toLowerCase();
  if (!activeWindowsLauncher) {
    rmSync(paths.shim, { force: true });
  }
  rmSync(paths.skill, { recursive: true, force: true });
  if (options.purge === true) {
    rmSync(paths.runtimeRoot, { recursive: true, force: true });
    rmSync(
      options.purgeDataDirectory ??
        manifest?.dataDirectory ??
        path.join(options.home ?? homedir(), ".codexhook"),
      {
        recursive: true,
        force: true,
      },
    );
  } else if (existsSync(paths.runtimeRoot)) {
    for (const entry of readdirSync(paths.runtimeRoot)) {
      if (entry !== path.basename(paths.manifest)) {
        rmSync(path.join(paths.runtimeRoot, entry), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}
export function installedRuntimePath(
  paths = installationPaths(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    if (platform === "win32") {
      const runtime = path.join(paths.currentLink, "codexhook.mjs");
      return existsSync(runtime) ? runtime : null;
    }
    const target = readlinkSync(paths.currentLink);
    const directory = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(paths.currentLink), target);
    return path.join(directory, "codexhook.mjs");
  } catch {
    return null;
  }
}
