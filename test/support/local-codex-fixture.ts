import { Effect, Stream } from "effect";
import type { LocalCodexService } from "../../src/contracts/local-codex.js";
import { sanitizeDiagnostic } from "../../src/contracts/diagnostics.js";

export function availabilityService(
  status: "available" | "unavailable",
): LocalCodexService {
  return {
    availability: Effect.succeed(status === "available"
      ? {
        status: "available" as const,
        compatibility: {
          status: "compatible" as const,
          plane: "app-server" as const,
          major: 2,
          revision: 1,
          features: [],
        },
      }
      : {
        status: "unavailable" as const,
        diagnostic: sanitizeDiagnostic({
          code: "app-server-unavailable",
          stage: "check-app-server",
          route: "app-server",
        }),
      }),
    listTasks: Effect.die("not used"),
    readHistory: () => Effect.die("not used"),
    resolveTask: () => Effect.die("not used"),
    events: () => Stream.die("not used"),
    submit: () => Effect.die("not used"),
  };
}
