import type { DesktopWireEnvelope } from "./types.js";

const MAX_ROUTING_ID_LENGTH = 256;

export class DesktopThreadOwners {
  private readonly owners = new Map<string, string>();
  private readonly waiters = new Map<
    string,
    Set<(owner: string | null) => void>
  >();

  drop(threadId: string): void {
    this.owners.delete(threadId);
  }

  reset(): void {
    this.owners.clear();
    for (const pending of this.waiters.values()) {
      for (const resolve of pending) resolve(null);
    }
    this.waiters.clear();
  }

  observe(
    message: DesktopWireEnvelope,
    followedThreads: ReadonlySet<string>,
  ): void {
    const threadId = snapshotThreadId(message);
    if (
      threadId != null &&
      followedThreads.has(threadId) &&
      typeof message.sourceClientId === "string" &&
      validRoutingId(message.sourceClientId) &&
      !this.owners.has(threadId)
    ) {
      this.owners.set(threadId, message.sourceClientId);
      const pending = this.waiters.get(threadId);
      if (pending == null) return;
      this.waiters.delete(threadId);
      for (const resolve of pending) resolve(message.sourceClientId);
    }
  }

  target(threadId: string): string | undefined {
    return this.owners.get(threadId);
  }

  wait(threadId: string, timeoutMs: number): Promise<string | null> {
    const owner = this.target(threadId);
    if (owner != null) return Promise.resolve(owner);
    return new Promise((resolve) => {
      const pending = this.waiters.get(threadId) ?? new Set();
      const finish = (value: string | null) => {
        clearTimeout(timeout);
        pending.delete(finish);
        if (pending.size === 0) this.waiters.delete(threadId);
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null), timeoutMs);
      pending.add(finish);
      this.waiters.set(threadId, pending);
    });
  }
}

function snapshotThreadId(message: DesktopWireEnvelope): string | null {
  if (message.method !== "thread-stream-state-changed") return null;
  if (
    message.params == null ||
    typeof message.params !== "object" ||
    Array.isArray(message.params)
  ) return null;
  const params = message.params as {
    readonly change?: unknown;
    readonly conversationId?: unknown;
  };
  if (
    params.change == null ||
    typeof params.change !== "object" ||
    Array.isArray(params.change) ||
    (params.change as { readonly type?: unknown }).type !== "snapshot"
  ) return null;
  const value = params.conversationId;
  return typeof value === "string" && validRoutingId(value) ? value : null;
}

function validRoutingId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ROUTING_ID_LENGTH;
}
