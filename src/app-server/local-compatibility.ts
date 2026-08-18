import type { ProtocolAvailability } from "../contracts/compatibility.js";
import { checkProtocolCompatibility } from "../contracts/compatibility.js";
import { sanitizeDiagnostic } from "../contracts/diagnostics.js";
import type { CanonicalAppServerClient } from "./client.js";

const REQUIREMENT = {
  plane: "app-server",
  major: 2,
  minimumRevision: 1,
  requiredFeatures: [
    "task-list",
    "task-history",
    "task-events",
    "turn-start",
    "turn-steer",
    "delivery-id",
  ],
} as const;

const OFFER = {
  plane: "app-server",
  major: 2,
  revision: 1,
  features: [...REQUIREMENT.requiredFeatures],
} as const;

function supportsBoundSchema(client: CanonicalAppServerClient): boolean {
  const userAgent = client.peer.serverInfo?.userAgent;
  if (userAgent == null) return false;
  const version = /\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent);
  if (version == null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 0 || (major === 0 && minor >= 147);
}

export function appServerCompatibility(
  client: CanonicalAppServerClient,
): ProtocolAvailability {
  if (!supportsBoundSchema(client)) {
    return {
      status: "incompatible",
      diagnostic: sanitizeDiagnostic({
        code: "app-server-incompatible",
        stage: "check-app-server",
        route: "app-server",
      }),
    };
  }
  const compatibility = checkProtocolCompatibility(REQUIREMENT, OFFER);
  return compatibility.status === "compatible"
    ? { status: "available", compatibility }
    : {
      status: "incompatible",
      diagnostic: sanitizeDiagnostic({
        code: "app-server-incompatible",
        stage: "check-app-server",
        route: "app-server",
      }),
    };
}
