import { DesktopProtocolError } from "./errors.js";
import type { NegotiatedConnection } from "./session-negotiate.js";
import type { DesktopProtocolCapability } from "./types.js";

export function requireDesktopCapability(
  connection: NegotiatedConnection,
  capability: DesktopProtocolCapability,
): void {
  if (connection.profile.capabilities[capability]) return;
  throw new DesktopProtocolError(
    "unsupported-capability",
    "operation",
    "not-written",
    `Desktop IPC does not advertise ${capability}`,
  );
}
