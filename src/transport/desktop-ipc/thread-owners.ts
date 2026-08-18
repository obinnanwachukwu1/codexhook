import type { DesktopWireEnvelope } from "./types.js";
import { routingId } from "./routing-id.js";

export class DesktopThreadOwners {
  private readonly owners = new Map<string, string>();
  private readonly unroutable = new Set<string>();
  private readonly waiters = new Map<
    string,
    Set<(owner: string | null) => void>
  >();
  private closed = false;

  drop(threadId: string): void {
    this.owners.delete(threadId);
    this.unroutable.delete(threadId);
  }

  invalidate(threadId: string): void {
    this.owners.delete(threadId);
    this.unroutable.add(threadId);
    this.resolveThread(threadId, null);
  }

  needsRefresh(threadId: string): boolean {
    return this.unroutable.has(threadId);
  }

  beginRefresh(threadId: string): void {
    this.unroutable.delete(threadId);
  }

  reset(refreshThreads: Iterable<string> = []): void {
    this.owners.clear();
    this.unroutable.clear();
    for (const threadId of refreshThreads) this.unroutable.add(threadId);
    this.resolveWaiters(null);
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  observe(
    message: DesktopWireEnvelope,
    followedThreads: ReadonlySet<string>,
  ): void {
    const threadId = snapshotThreadId(message);
    if (threadId == null || !followedThreads.has(threadId)) return;
    const source = routingId(message.sourceClientId);
    if (source == null) {
      if (!this.owners.has(threadId)) {
        this.unroutable.add(threadId);
        this.resolveThread(threadId, null);
      }
      return;
    }
    if (!this.owners.has(threadId)) {
      this.unroutable.delete(threadId);
      this.owners.set(threadId, source);
      const pending = this.waiters.get(threadId);
      if (pending == null) return;
      this.waiters.delete(threadId);
      for (const resolve of pending) resolve(source);
    }
  }

  target(threadId: string): string | undefined {
    return this.owners.get(threadId);
  }

  wait(threadId: string, timeoutMs: number): Promise<string | null> {
    const owner = this.target(threadId);
    if (owner != null) return Promise.resolve(owner);
    if (this.closed || this.unroutable.has(threadId)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const pending = this.waiters.get(threadId) ?? new Set();
      const finish = (value: string | null) => {
        clearTimeout(timeout);
        pending.delete(finish);
        if (pending.size === 0) this.waiters.delete(threadId);
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null), timeoutMs);
      timeout.unref();
      pending.add(finish);
      this.waiters.set(threadId, pending);
    });
  }

  private resolveThread(threadId: string, value: string | null): void {
    const pending = this.waiters.get(threadId);
    if (pending == null) return;
    this.waiters.delete(threadId);
    for (const resolve of pending) resolve(value);
  }

  private resolveWaiters(value: string | null): void {
    for (const threadId of [...this.waiters.keys()]) {
      this.resolveThread(threadId, value);
    }
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
  return typeof value === "string" && value.length > 0 ? value : null;
}
