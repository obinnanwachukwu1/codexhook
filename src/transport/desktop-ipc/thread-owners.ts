import type { DesktopWireEnvelope } from "./types.js";

const MAX_ROUTING_ID_LENGTH = 256;

export class DesktopThreadOwners {
  private readonly owners = new Map<string, string>();

  clear(): void {
    this.owners.clear();
  }

  observe(message: DesktopWireEnvelope): void {
    const threadId = broadcastThreadId(message);
    if (
      threadId != null &&
      typeof message.sourceClientId === "string" &&
      validRoutingId(message.sourceClientId)
    ) {
      this.owners.set(threadId, message.sourceClientId);
    }
  }

  target(threadId: string): string | undefined {
    return this.owners.get(threadId);
  }
}

function broadcastThreadId(message: DesktopWireEnvelope): string | null {
  if (message.method !== "thread-stream-state-changed") return null;
  if (
    message.params == null ||
    typeof message.params !== "object" ||
    Array.isArray(message.params)
  ) return null;
  const value = (message.params as { readonly conversationId?: unknown })
    .conversationId;
  return typeof value === "string" && validRoutingId(value) ? value : null;
}

function validRoutingId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ROUTING_ID_LENGTH;
}
