import { existsSync } from "node:fs";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultBaseUrl,
} from "./config.js";
import {
  installationPaths,
  kickstartLaunchAgent,
  readInstallManifest,
} from "./installation.js";

export interface DaemonHealth {
  state: "available" | "degraded";
  version: string;
  coPresence: boolean;
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
      capabilities?: { coPresence?: unknown };
    };
    if (body.service !== "codexhook" || typeof body.version !== "string") {
      return { state: "occupied" };
    }
    return {
      state: "running",
      health: {
        state: body.status === "ok" ? "available" : "degraded",
        version: body.version,
        coPresence: body.capabilities?.coPresence === true,
      },
    };
  } catch {
    return { state: "occupied" };
  }
}

async function waitForDaemon(): Promise<DaemonProbe> {
  const deadline = Date.now() + 3_000;
  let result = await probeDaemon();
  while (result.state === "down" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await probeDaemon();
  }
  return result;
}

export async function requireDaemon(): Promise<DaemonHealth> {
  let probe = await probeDaemon();
  if (probe.state === "occupied") {
    throw new Error("port 9465 is occupied by a service that is not codexhook");
  }
  if (probe.state === "running") return probe.health;

  const paths = installationPaths();
  const manifest = readInstallManifest(paths);
  if (
    manifest == null ||
    !existsSync(paths.launchAgent) ||
    !existsSync(manifest.nodePath)
  ) {
    throw new Error(
      "codexhook is not installed on this machine. Run: npx codexhook@latest setup",
    );
  }
  kickstartLaunchAgent();
  probe = await waitForDaemon();
  if (probe.state === "occupied") {
    throw new Error("port 9465 is occupied by a service that is not codexhook");
  }
  if (probe.state === "down") {
    throw new Error(
      "codexhook could not start. Run: codexhook doctor",
    );
  }
  return probe.health;
}
