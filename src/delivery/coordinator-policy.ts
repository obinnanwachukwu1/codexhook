import type { TurnId } from "../types.js";
import type {
  DeliveryEvidence,
  DesktopWriteReceipt,
  RoutingDiagnostic,
} from "./routing-contracts.js";
import { WRITE_AMBIGUOUS } from "./routing-contracts.js";

export type DesktopEvidenceDecision =
  | { readonly _tag: "Confirm"; readonly turnId: TurnId }
  | { readonly _tag: "Fallback" }
  | { readonly _tag: "Ambiguous"; readonly diagnostic: RoutingDiagnostic };

export function decideDesktopEvidence(
  receipt: DesktopWriteReceipt,
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
        diagnostic: WRITE_AMBIGUOUS,
      }
    : { _tag: "Confirm", turnId: canonical.turnId };
}
