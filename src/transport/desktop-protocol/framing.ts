import { TextDecoder } from "node:util";
import { DesktopProtocolError } from "./errors.js";
import type { DesktopWireEnvelope } from "./types.js";

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

function frameError(message: string): DesktopProtocolError {
  return new DesktopProtocolError(
    "frame-invalid",
    "framing",
    "unknown",
    message,
  );
}

function wireEnvelope(value: unknown): DesktopWireEnvelope {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw frameError("Desktop IPC frame must contain an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    record.type.length === 0 ||
    record.type.length > 64
  ) {
    throw frameError("Desktop IPC frame has an invalid envelope type");
  }
  if (
    record.requestId != null &&
    (typeof record.requestId !== "string" ||
      record.requestId.length === 0 ||
      record.requestId.length > 128)
  ) {
    throw frameError("Desktop IPC frame has an invalid request id");
  }
  if (
    record.method != null &&
    (typeof record.method !== "string" || record.method.length > 160)
  ) {
    throw frameError("Desktop IPC frame has an invalid method");
  }
  if (
    record.resultType != null &&
    record.resultType !== "success" &&
    record.resultType !== "error"
  ) {
    throw frameError("Desktop IPC frame has an invalid result type");
  }
  return record as unknown as DesktopWireEnvelope;
}

export function encodeDesktopFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new DesktopProtocolError(
      "frame-invalid",
      "framing",
      "not-written",
      "Desktop IPC request could not be serialized",
      undefined,
      { cause },
    );
  }
  if (typeof serialized !== "string") {
    throw new DesktopProtocolError(
      "frame-invalid",
      "framing",
      "not-written",
      "Desktop IPC request could not be serialized",
    );
  }
  const body = Buffer.from(serialized);
  if (body.length === 0 || body.length > maxFrameBytes) {
    throw new DesktopProtocolError(
      "frame-invalid",
      "framing",
      "not-written",
      "Desktop IPC request exceeds the frame limit",
    );
  }
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class DesktopFrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  ) {}

  push(chunk: Buffer): ReadonlyArray<DesktopWireEnvelope> {
    if (chunk.length === 0) return [];
    let data = this.buffer.length === 0
      ? chunk
      : Buffer.concat([this.buffer, chunk]);
    this.buffer = Buffer.alloc(0);
    const messages: DesktopWireEnvelope[] = [];
    while (data.length >= 4) {
      const length = data.readUInt32LE(0);
      if (length === 0 || length > this.maxFrameBytes) {
        throw frameError("Desktop IPC frame length is outside bounds");
      }
      if (data.length < length + 4) break;
      const body = data.subarray(4, length + 4);
      data = data.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(body));
      } catch (cause) {
        throw new DesktopProtocolError(
          "frame-invalid",
          "framing",
          "unknown",
          "Desktop IPC frame contains invalid JSON or UTF-8",
          undefined,
          { cause },
        );
      }
      messages.push(wireEnvelope(parsed));
    }
    if (data.length > this.maxFrameBytes + 4) {
      throw frameError("Desktop IPC buffered data exceeds the frame limit");
    }
    this.buffer = Buffer.from(data);
    return messages;
  }
}
