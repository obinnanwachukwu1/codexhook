import { normalizeDesktopRejection } from "./adapters.js";
import { DesktopProtocolError } from "./errors.js";
import type {
  DesktopProtocolProfile,
  DesktopRequestReceipt,
  DesktopResponseEnvelope,
} from "./types.js";

export function desktopRequestReceipt<A>(
  profile: DesktopProtocolProfile,
  operation: DesktopRequestReceipt<A>["operation"],
  response: DesktopResponseEnvelope,
  decode: (value: unknown) => A,
): DesktopRequestReceipt<A> {
  if (
    response.resultType != null &&
    response.resultType !== "success" &&
    response.resultType !== "error"
  ) {
    throw new DesktopProtocolError(
      "response-malformed",
      "operation",
      "written",
      "Desktop IPC response has an unknown result type",
    );
  }
  return {
    fingerprint: profile.fingerprint,
    operation,
    requestId: response.requestId,
    outcome: response.resultType === "error"
      ? {
          _tag: "Rejected",
          rejection: normalizeDesktopRejection(response.error),
        }
      : { _tag: "Accepted", value: decode(response.result) },
  };
}
