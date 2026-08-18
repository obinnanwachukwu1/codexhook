import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Effect, Option } from "effect";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  dataDirectory,
  defaultBaseUrl,
} from "../config.js";
import { startUnifiedDaemon } from "../daemon.js";
import { probeDaemon, requireDaemon } from "../daemon-control.js";
import {
  installationPaths,
  installationServicePaths,
  readInstallManifest,
  setupInstallation,
  uninstallInstallation,
} from "../installation.js";
import { backgroundServiceExists } from "../background-service.js";
import { Logger } from "../logger.js";
import { chooseInstallationPort, parsePort } from "../port.js";
import { desktopProbe } from "../transport/desktop-endpoint.js";
import { discoverStandalone } from "../transport/discovery.js";
import { VERSION } from "../version.js";

export async function setup(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    options: {
      "base-url": { type: "string" },
      port: { type: "string" },
    },
  });
  const previous = readInstallManifest();
  const requested =
    values.port == null ? undefined : parsePort(values.port);
  const port = await chooseInstallationPort({
    requested,
    previous: previous?.port,
  });
  const manifest = setupInstallation({
    baseUrl: values["base-url"],
    port,
  });
  const health = await requireDaemon();
  process.stdout.write(`Installed codexhook ${manifest.version}.\n`);
  process.stdout.write(
    `Daemon ${health.state} on 127.0.0.1:${manifest.port}; URLs use ${manifest.baseUrl}.\n`,
  );
  const paths = installationPaths();
  const shimDirectory = path.dirname(paths.shim);
  if (
    !(process.env.PATH ?? "")
      .split(path.delimiter)
      .includes(shimDirectory)
  ) {
    process.stdout.write(
      `Add ${shimDirectory} to PATH, or use ${paths.shim}.\n`,
    );
  }
}

export async function uninstall(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    options: {
      purge: { type: "boolean", default: false },
    },
  });
  const paths = installationPaths();
  uninstallInstallation({
    purge: values.purge,
    purgeDataDirectory: dataDirectory(),
  });
  process.stdout.write("Removed the codexhook service, runtime, and skill.\n");
  process.stdout.write(
    values.purge
      ? `Removed ${dataDirectory()} (webhooks and logs).\n`
      : `Preserved ${dataDirectory()} (use --purge to remove it).\n`,
  );
  process.stdout.write(`Removed launcher ${paths.shim}.\n`);
}

export async function serve(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    options: {
      host: { type: "string", default: DEFAULT_HOST },
      port: { type: "string", default: String(DEFAULT_PORT) },
      "data-directory": { type: "string" },
    },
  });
  const host = values.host ?? DEFAULT_HOST;
  const port = parsePort(values.port ?? String(DEFAULT_PORT));
  const directory = values["data-directory"] ?? dataDirectory();
  const logger = new Logger();
  const daemon = await startUnifiedDaemon({
    host,
    port,
    dataDirectory: directory,
    logger,
  });
  await new Promise<void>((resolve, reject) => {
    const shutdown = (reason: string) => {
      void daemon.stop(reason).then(resolve, reject);
    };
    const onInterrupt = () => shutdown("SIGINT");
    const onTerminate = () => shutdown("SIGTERM");
    const onError = (error: Error) => {
      void daemon.stop("server-error").then(() => reject(error), reject);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    daemon.server.once("error", onError);
    daemon.server.once("close", () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      daemon.server.off("error", onError);
    });
  });
}

export async function status(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    options: { json: { type: "boolean", default: false } },
  });
  const manifest = readInstallManifest();
  const port = manifest?.port ?? DEFAULT_PORT;
  const origin = defaultBaseUrl(DEFAULT_HOST, port);
  const daemon = await probeDaemon(origin);
  const report = {
    daemon,
    origin,
    publicBaseUrl: manifest?.baseUrl ?? null,
  };
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (daemon.state === "running") {
    process.stdout.write(
      `codexhook ${daemon.health.state} at ${origin} (${daemon.health.phase}).\n`,
    );
    process.stdout.write(
      `delivery: ${daemon.health.delivery}; task access candidates: ${daemon.health.taskAccessCandidatesFound ? "found" : "none"}; Desktop IPC: ${daemon.health.desktopIpcAvailable ? "available" : "unavailable"}.\n`,
    );
  } else {
    process.stdout.write(`codexhook daemon: ${daemon.state}.\n`);
  }
  if (daemon.state !== "running") process.exitCode = 1;
}

function nodeVersion(executable: string): string | null {
  try {
    return execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
  } catch {
    return null;
  }
}

export async function doctor(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
    },
  });
  const paths = installationPaths();
  const manifest = readInstallManifest(paths);
  const daemon = await probeDaemon(
    defaultBaseUrl(DEFAULT_HOST, manifest?.port ?? DEFAULT_PORT),
  );
  const desktop = await Effect.runPromise(desktopProbe);
  const runtimes = [
    ...Option.toArray(desktop),
    ...(await discoverStandalone()),
  ];
  const recordedNode =
    manifest == null ? null : nodeVersion(manifest.nodePath);
  const report = {
    ok:
      manifest != null &&
      recordedNode != null &&
      existsSync(paths.currentLink) &&
      existsSync(paths.skill) &&
      backgroundServiceExists(installationServicePaths(paths)) &&
      daemon.state === "running",
    version: VERSION,
    installation: {
      manifest,
      runtime: existsSync(paths.currentLink),
      skill: existsSync(paths.skill),
      service: backgroundServiceExists(installationServicePaths(paths)),
      nodeVersion: recordedNode,
    },
    daemon,
    codex: {
      available: runtimes.length > 0,
      desktopIpcAvailable: Option.isSome(desktop),
      runtimes,
    },
    dataDirectory: dataDirectory(),
  };
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(
      `codexhook ${VERSION}: ${report.ok ? "ok" : "needs repair"}\n`,
    );
    process.stdout.write(
      `installation: ${manifest?.version ?? "missing"}; node: ${recordedNode ?? "missing"}; skill: ${report.installation.skill ? "installed" : "missing"}; service: ${report.installation.service ? "installed" : "missing"}\n`,
    );
    process.stdout.write(`daemon: ${daemon.state}\n`);
    const desktopStatus = report.codex.desktopIpcAvailable
      ? "available; task visibility is verified per delivery"
      : "unavailable";
    process.stdout.write(
      `codex: ${report.codex.available ? "available" : "unavailable"}; Desktop IPC: ${desktopStatus}\n`,
    );
    if (!report.ok) {
      process.stdout.write(
        "repair: npx codexhook@latest setup\n",
      );
    }
  }
  if (!report.ok) process.exitCode = 1;
}
