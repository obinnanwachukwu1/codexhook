import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  dataDirectory,
  databasePath,
  defaultBaseUrl,
  diagnosticJournalPath,
} from "../config.js";
import { probeDaemon, requireDaemon } from "../daemon-control.js";
import { DeliveryLive } from "../delivery/delivery.js";
import {
  installationPaths,
  installationServicePaths,
  readInstallManifest,
  setupInstallation,
  uninstallInstallation,
} from "../installation.js";
import { backgroundServiceExists } from "../background-service.js";
import { Logger } from "../logger.js";
import {
  authorizeCompatibilityReport,
  buildCompatibilityReport,
  previewCompatibilityReport,
} from "../diagnostics/support-report.js";
import { DiagnosticJournal } from "../diagnostics/journal.js";
import { DIAGNOSTIC_STAGES } from "../diagnostics/contracts.js";
import { chooseInstallationPort, parsePort } from "../port.js";
import { WebhookRegistry } from "../registry.js";
import { listen } from "../server.js";
import { desktopProbe } from "../transport/desktop-endpoint.js";
import { discoverStandalone } from "../transport/discovery.js";
import { TransportProviderLive } from "../transport/provider.js";
import { makeCodexTransportLive } from "../transport/transport.js";
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
  const journal = new DiagnosticJournal(diagnosticJournalPath(directory));
  const logger = new Logger();
  const store = new WebhookRegistry(databasePath(directory));
  const appLayer = DeliveryLive(logger, journal).pipe(
    Layer.provideMerge(makeCodexTransportLive(logger, journal)),
    Layer.provide(TransportProviderLive(logger, journal)),
  );
  const runtime = ManagedRuntime.make(appLayer);
  const server = await listen({
    host,
    port,
    registry: store,
    runtime,
    logger,
  });
  logger.info("server_listening", { host, port, database: store.path });

  const shutdown = async (signal: string) => {
    logger.info("server_stopping", { signal });
    server.close();
    await runtime.dispose();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
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
      "compatibility-report": { type: "boolean", default: false },
      consent: { type: "boolean", default: false },
      "data-directory": { type: "string" },
    },
  });
  if (values.consent && !values["compatibility-report"]) {
    throw new Error("--consent requires --compatibility-report");
  }
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
  const directory = values["data-directory"] ?? dataDirectory();
  const journal = new DiagnosticJournal(diagnosticJournalPath(directory));
  const journalSnapshot = journal.read();
  const diagnosticFailures = journal.failures(journalSnapshot);
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
    diagnostics: {
      path: journal.filePath,
      supportedStages: DIAGNOSTIC_STAGES,
      entries: journalSnapshot.records.length,
      invalidEntries: journalSnapshot.invalidLines,
      boundedBy: journalSnapshot.boundedBy,
      failures: diagnosticFailures,
    },
    dataDirectory: directory,
  };
  if (values["compatibility-report"]) {
    const compatibilityPayload = buildCompatibilityReport({
      version: VERSION,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      installation: {
        manifest: manifest != null,
        runtime: report.installation.runtime,
        skill: report.installation.skill,
        service: report.installation.service,
        nodeCompatible: recordedNode != null,
      },
      daemonState: daemon.state,
      desktopIpcAvailable: report.codex.desktopIpcAvailable,
      candidates: runtimes.map((runtime) => runtime.id),
      journal: journalSnapshot,
      failures: diagnosticFailures,
    });
    const preview = previewCompatibilityReport(compatibilityPayload);
    const output = values.consent
      ? authorizeCompatibilityReport(preview)
      : preview;
    process.stdout.write(
      `${JSON.stringify(output, null, values.json ? undefined : 2)}\n`,
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }
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
    if (diagnosticFailures.length === 0) {
      process.stdout.write("diagnostics: no recent classified failures\n");
    } else {
      process.stdout.write("diagnostics (recent classified failures):\n");
      for (const failure of diagnosticFailures) {
        process.stdout.write(
          `  ${failure.stage}: ${failure.code} (${failure.outcome}, ${failure.count}x${failure.deliveryTruth == null ? "" : `, delivery=${failure.deliveryTruth}`})\n`,
        );
      }
    }
    process.stdout.write(
      "compatibility report: codexhook doctor --compatibility-report (local preview; nothing is sent)\n",
    );
    if (!report.ok) {
      process.stdout.write(
        "repair: npx codexhook@latest setup\n",
      );
    }
  }
  if (!report.ok) process.exitCode = 1;
}
