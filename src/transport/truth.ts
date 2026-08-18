import type { TransportId } from "../types.js";

export const DELIVERY_TRUTHS = [
  "confirmed_desktop",
  "confirmed_app_server",
  "ambiguous",
  "unavailable",
  "rejected",
] as const;

export type DeliveryTruth = (typeof DELIVERY_TRUTHS)[number];

export function truthForTransport(transport: TransportId): DeliveryTruth {
  return transport === "desktop"
    ? "confirmed_desktop"
    : "confirmed_app_server";
}
