import type { TurnId } from "../types.js";
import type {
  DeliveryEvidence,
  DeliveryReceipt,
  DesktopWriteReceipt,
  RoutingDiagnostic,
} from "./routing-contracts.js";
import { WRITE_AMBIGUOUS } from "./routing-contracts.js";

export type DesktopEvidenceDecision =
  | { readonly _tag: "Confirm"; readonly turnId: TurnId }
  | { readonly _tag: "Fallback" }
  | { readonly _tag: "Ambiguous"; readonly diagnostic: RoutingDiagnostic };

/** The coordinator returned before the native write was known to have settled. */
export function unsettledWriteDiagnostic(
  receipt: DeliveryReceipt,
): RoutingDiagnostic | null {
  return receipt._tag === "Uncertain" &&
    (receipt.diagnostic.code === "timeout" ||
      receipt.diagnostic.code === "internal")
    ? receipt.diagnostic
    : null;
}

export function decideDesktopEvidence(
  receipt: DesktopWriteReceipt,
  desktop: DeliveryEvidence,
  canonical: DeliveryEvidence,
): DesktopEvidenceDecision {
  if (canonical._tag === "Absent") {
    const unsettled = unsettledWriteDiagnostic(receipt);
    return unsettled != null
      ? { _tag: "Ambiguous", diagnostic: unsettled }
      : { _tag: "Fallback" };
  }
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
