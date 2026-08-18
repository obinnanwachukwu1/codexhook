import { TextDecoder } from "node:util";
import { DesktopProtocolError } from "./errors.js";
import type { DesktopWireEnvelope } from "./types.js";

export const DEFAULT_MAX_INBOUND_FRAME_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_OUTBOUND_FRAME_BYTES = 16 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

function frameError(message: string): DesktopProtocolError {
  return new DesktopProtocolError(
    "frame-invalid",
    "framing",
    "unknown",
    message,
  );
}

function wireEnvelope(value: unknown): DesktopWireEnvelope | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    record.type.length === 0 ||
    record.type.length > 64
  ) {
    return null;
  }
  if (
    record.requestId != null &&
    (typeof record.requestId !== "string" ||
      record.requestId.length === 0 ||
      record.requestId.length > 128)
  ) {
    return null;
  }
  if (
    record.method != null &&
    (typeof record.method !== "string" || record.method.length > 160)
  ) {
    return null;
  }
  if (record.resultType != null && typeof record.resultType !== "string") {
    return null;
  }
  return record as unknown as DesktopWireEnvelope;
}

export function encodeDesktopFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
): Buffer {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw encodeError("Desktop IPC request could not be serialized");
  }
  if (typeof serialized !== "string") {
    throw encodeError("Desktop IPC request could not be serialized");
  }
  const body = Buffer.from(serialized);
  if (body.length === 0 || body.length > maxFrameBytes) {
    throw encodeError("Desktop IPC request exceeds the frame limit");
  }
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function encodeError(message: string): DesktopProtocolError {
  return new DesktopProtocolError(
    "frame-invalid",
    "framing",
    "not-written",
    message,
  );
}

export class DesktopFrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(
    private readonly maxFrameBytes = DEFAULT_MAX_INBOUND_FRAME_BYTES,
    private readonly onMalformedEnvelope: () => void = () => undefined,
  ) {}

  push(chunk: Buffer): ReadonlyArray<DesktopWireEnvelope> {
    if (chunk.length === 0) return [];
    const data = this.buffer.length === 0
      ? chunk
      : Buffer.concat([this.buffer, chunk]);
    this.buffer = Buffer.alloc(0);
    const messages: DesktopWireEnvelope[] = [];
    let offset = 0;
    while (data.length - offset >= 4) {
      const length = data.readUInt32LE(offset);
      if (length === 0 || length > this.maxFrameBytes) {
        throw frameError("Desktop IPC frame length is outside bounds");
      }
      if (data.length - offset < length + 4) break;
      const body = data.subarray(offset + 4, offset + length + 4);
      offset += length + 4;
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(body));
      } catch {
        throw frameError("Desktop IPC frame contains invalid JSON or UTF-8");
      }
      const envelope = wireEnvelope(parsed);
      if (envelope == null) this.onMalformedEnvelope();
      else messages.push(envelope);
    }
    const remaining = data.subarray(offset);
    this.buffer = offset === 0 ? data : Buffer.from(remaining);
    return messages;
  }
}
