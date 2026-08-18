import type { DesktopWireEnvelope } from "./types.js";

export interface DesktopStreamEnvelope {
  readonly change: Record<string, unknown>;
  readonly threadId: string;
}

export function desktopStreamEnvelope(
  message: DesktopWireEnvelope,
): DesktopStreamEnvelope | null {
  if (
    message.method !== "thread-stream-state-changed" ||
    message.params == null ||
    typeof message.params !== "object" ||
    Array.isArray(message.params)
  ) return null;
  const params = message.params as {
    readonly change?: unknown;
    readonly conversationId?: unknown;
  };
  if (
    typeof params.conversationId !== "string" ||
    params.conversationId.length === 0 ||
    params.change == null ||
    typeof params.change !== "object" ||
    Array.isArray(params.change)
  ) return null;
  return {
    change: params.change as Record<string, unknown>,
    threadId: params.conversationId,
  };
}
