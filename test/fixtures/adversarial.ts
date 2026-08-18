import type { DeliveryTruth, DiagnosticStage } from "../../src/diagnostics/contracts.js";

export interface AdversarialFixture {
  readonly name: string;
  readonly plane: "desktop" | "app_server" | "coordinator" | "report";
  readonly stage: DiagnosticStage;
  readonly expectedTruth?: DeliveryTruth;
}

export const ADVERSARIAL_FIXTURES: ReadonlyArray<AdversarialFixture> = [
  { name: "disconnect-before-write", plane: "app_server", stage: "submission", expectedTruth: "unavailable" },
  { name: "disconnect-after-write", plane: "app_server", stage: "submission", expectedTruth: "ambiguous" },
  { name: "lost-acknowledgement", plane: "app_server", stage: "submission", expectedTruth: "ambiguous" },
  { name: "canonical-item-found", plane: "app_server", stage: "canonical_verification", expectedTruth: "confirmed_app_server" },
  { name: "canonical-item-absent", plane: "app_server", stage: "canonical_verification", expectedTruth: "ambiguous" },
  { name: "canonical-item-unknown", plane: "app_server", stage: "canonical_verification", expectedTruth: "ambiguous" },
  { name: "socket-replacement", plane: "desktop", stage: "attachment" },
  { name: "codex-restart", plane: "desktop", stage: "attachment" },
  { name: "stale-active-turn", plane: "desktop", stage: "state_synchronization" },
  { name: "revision-gap", plane: "desktop", stage: "state_synchronization" },
  { name: "reordered-patches", plane: "desktop", stage: "state_synchronization" },
  { name: "incompatible-response-shapes", plane: "desktop", stage: "protocol", expectedTruth: "unavailable" },
  { name: "concurrent-tasks", plane: "coordinator", stage: "submission", expectedTruth: "confirmed_app_server" },
  { name: "circuit-breaker-recovery", plane: "coordinator", stage: "circuit_breaker" },
  { name: "redaction", plane: "report", stage: "protocol" },
];

export function desktopStateChange(
  change: unknown,
  conversationId = "thread-1",
) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    params: { conversationId, hostId: "local", change },
  } as const;
}
