export {
  DesktopProtocolError,
  isAbsentDesktopEndpointError,
} from "./errors.js";
export type { DesktopWriteState } from "./errors.js";
export {
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
  DesktopFrameDecoder,
  encodeDesktopFrame,
} from "./framing.js";
export { DesktopProtocolSession } from "./session.js";
export type {
  DesktopCapabilities,
  DesktopKnownRejection,
  DesktopProtocolOperation,
  DesktopProtocolFingerprint,
  DesktopProtocolObservation,
  DesktopProtocolProfile,
  DesktopProtocolSessionOptions,
  DesktopRequestReceipt,
  DesktopStartResult,
  DesktopSteerResult,
  DesktopWireEnvelope,
  DesktopWriteReceipt,
} from "./types.js";
