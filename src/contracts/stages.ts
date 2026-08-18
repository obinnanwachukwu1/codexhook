export const DELIVERY_STAGES = [
  "resolve-task",
  "check-app-server",
  "probe-desktop",
  "connect-desktop",
  "follow-desktop",
  "submit-desktop",
  "submit-app-server",
  "reconcile-app-server",
  "await-turn",
] as const;

export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

const STAGES = new Set<string>(DELIVERY_STAGES);

export function isDeliveryStage(value: unknown): value is DeliveryStage {
  return typeof value === "string" && STAGES.has(value);
}
