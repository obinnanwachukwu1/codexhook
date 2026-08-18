export {
  DesktopProtocolError,
  isAbsentDesktopEndpointError,
} from "./errors.js";
export {
  DEFAULT_MAX_FRAME_BYTES,
  DesktopFrameDecoder,
  encodeDesktopFrame,
} from "./framing.js";
export { DesktopProtocolSession } from "./session.js";
export type {
  DesktopCapabilities,
  DesktopKnownRejection,
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
