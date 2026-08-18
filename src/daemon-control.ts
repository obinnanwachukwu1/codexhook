import { existsSync } from "node:fs";
import { backgroundServiceExists } from "./background-service.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultBaseUrl,
} from "./config.js";
import {
  installationPaths,
  installationServicePaths,
  kickstartLaunchAgent,
  readInstallManifest,
} from "./installation.js";

export interface DaemonHealth {
  state: "available" | "degraded";
  version: string;
  desktopIpcAvailable: boolean;
  phase: "starting" | "ready" | "draining" | "stopped" | "unknown";
  taskAccessStatus:
    | "available"
    | "unavailable"
    | "incompatible"
    | "unknown";
}

export type DaemonProbe =
  | { state: "running"; health: DaemonHealth }
  | { state: "down" }
  | { state: "occupied" };

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

export async function probeDaemon(
  origin = defaultBaseUrl(DEFAULT_HOST, DEFAULT_PORT),
  timeoutMs = 2_500,
): Promise<DaemonProbe> {
  let response: Response;
  try {
    response = await fetch(new URL("/healthz", origin), {
      signal: timeoutSignal(timeoutMs),
    });
  } catch {
    return { state: "down" };
  }
  try {
    const body = await response.json() as {
      service?: unknown;
      version?: unknown;
      status?: unknown;
      capabilities?: {
        desktopIpcAvailable?: unknown;
      };
      lifecycle?: { phase?: unknown };
      taskAccess?: { status?: unknown } | null;
    };
    if (body.service !== "codexhook" || typeof body.version !== "string") {
      return { state: "occupied" };
    }
    return {
      state: "running",
      health: {
        state: body.status === "ok" ? "available" : "degraded",
        version: body.version,
        desktopIpcAvailable:
          body.capabilities?.desktopIpcAvailable === true,
        phase:
          body.lifecycle?.phase === "starting" ||
          body.lifecycle?.phase === "ready" ||
          body.lifecycle?.phase === "draining" ||
          body.lifecycle?.phase === "stopped"
            ? body.lifecycle.phase
            : "unknown",
        taskAccessStatus:
          body.taskAccess?.status === "available" ||
            body.taskAccess?.status === "unavailable" ||
            body.taskAccess?.status === "incompatible"
            ? body.taskAccess.status
            : "unknown",
      },
    };
  } catch {
    return { state: "occupied" };
  }
}

async function waitForDaemon(origin: string): Promise<DaemonProbe> {
  const deadline = Date.now() + 3_000;
  let result = await probeDaemon(origin);
  while (result.state === "down" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await probeDaemon(origin);
  }
  return result;
}

export async function requireDaemon(): Promise<DaemonHealth> {
  const paths = installationPaths();
  const manifest = readInstallManifest(paths);
  const port = manifest?.port ?? DEFAULT_PORT;
  const origin = defaultBaseUrl(DEFAULT_HOST, port);
  let probe = await probeDaemon(origin);
  if (probe.state === "occupied") {
    throw new Error(
      `port ${port} is occupied by a service that is not codexhook`,
    );
  }
  if (probe.state === "running") return probe.health;

  if (
    manifest == null ||
    !backgroundServiceExists(installationServicePaths(paths)) ||
    !existsSync(manifest.nodePath)
  ) {
    throw new Error(
      "codexhook is not installed on this machine. Run: npx codexhook@latest setup",
    );
  }
  kickstartLaunchAgent();
  probe = await waitForDaemon(origin);
  if (probe.state === "occupied") {
    throw new Error(
      `port ${port} is occupied by a service that is not codexhook`,
    );
  }
  if (probe.state === "down") {
    throw new Error(
      "codexhook could not start. Run: codexhook doctor",
    );
  }
  return probe.health;
}
