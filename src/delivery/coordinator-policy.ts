import type { TurnId } from "../types.js";
import type {
  DeliveryEvidence,
  DeliveryReceipt,
  RoutingDiagnostic,
} from "./routing-contracts.js";

type DesktopReceipt = Extract<
  DeliveryReceipt,
  { readonly _tag: "Acknowledged" | "Uncertain" }
>;

export type DesktopEvidenceDecision =
  | { readonly _tag: "Confirm"; readonly turnId: TurnId }
  | { readonly _tag: "Fallback" }
  | { readonly _tag: "Ambiguous"; readonly diagnostic: RoutingDiagnostic };

export function decideDesktopEvidence(
  receipt: DesktopReceipt,
  desktop: DeliveryEvidence,
  canonical: DeliveryEvidence,
): DesktopEvidenceDecision {
  if (canonical._tag === "Absent") return { _tag: "Fallback" };
  if (canonical._tag === "Unresolved") {
    return { _tag: "Ambiguous", diagnostic: canonical.diagnostic };
  }
  const receiptConflict = receipt._tag === "Acknowledged" &&
    receipt.turnId !== canonical.turnId;
  const desktopConflict = desktop._tag === "Found" &&
    desktop.turnId !== canonical.turnId;
  return receiptConflict || desktopConflict
    ? {
        _tag: "Ambiguous",
        diagnostic: { code: "write-ambiguous" },
      }
    : { _tag: "Confirm", turnId: canonical.turnId };
}
