import type { DesktopWireEnvelope } from "./types.js";
import { routingId } from "./routing-id.js";
import { desktopStreamEnvelope } from "./stream-envelope.js";

export type OwnerWaitResult =
  | { readonly _tag: "Owner"; readonly owner: string }
  | { readonly _tag: "Closed" | "Reset" | "Timeout" | "Unroutable" };

export class DesktopThreadOwners {
  private readonly owners = new Map<string, string>();
  private readonly unroutable = new Set<string>();
  private readonly waiters = new Map<
    string,
    Set<(result: OwnerWaitResult) => void>
  >();
  private closed = false;

  drop(threadId: string): void {
    this.owners.delete(threadId);
    this.unroutable.delete(threadId);
  }

  invalidate(threadId: string): void {
    this.owners.delete(threadId);
    this.unroutable.add(threadId);
    this.resolveThread(threadId, { _tag: "Unroutable" });
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
    this.resolveWaiters({ _tag: "Reset" });
  }

  close(): void {
    this.closed = true;
    this.owners.clear();
    this.unroutable.clear();
    this.resolveWaiters({ _tag: "Closed" });
  }

  observe(
    message: DesktopWireEnvelope,
    followedThreads: ReadonlySet<string>,
  ): void {
    const stream = desktopStreamEnvelope(message);
    if (
      stream == null ||
      stream.change.type !== "snapshot" ||
      !followedThreads.has(stream.threadId)
    ) return;
    const threadId = stream.threadId;
    const source = routingId(message.sourceClientId);
    if (source == null) {
      if (!this.owners.has(threadId)) {
        this.unroutable.add(threadId);
        this.resolveThread(threadId, { _tag: "Unroutable" });
      }
      return;
    }
    if (!this.owners.has(threadId)) {
      // Pin the first post-follow owner until a targeted request rejects it;
      // later unsolicited snapshots must not silently retarget a mutation.
      this.unroutable.delete(threadId);
      this.owners.set(threadId, source);
      const pending = this.waiters.get(threadId);
      if (pending == null) return;
      this.waiters.delete(threadId);
      const result = { _tag: "Owner", owner: source } as const;
      for (const resolve of pending) resolve(result);
    }
  }

  target(threadId: string): string | undefined {
    return this.owners.get(threadId);
  }

  wait(threadId: string, timeoutMs: number): Promise<OwnerWaitResult> {
    const owner = this.target(threadId);
    if (owner != null) return Promise.resolve({ _tag: "Owner", owner });
    if (this.closed) return Promise.resolve({ _tag: "Closed" });
    if (this.unroutable.has(threadId)) {
      return Promise.resolve({ _tag: "Unroutable" });
    }
    return new Promise((resolve) => {
      const pending = this.waiters.get(threadId) ?? new Set();
      const finish = (value: OwnerWaitResult) => {
        clearTimeout(timeout);
        pending.delete(finish);
        if (pending.size === 0) this.waiters.delete(threadId);
        resolve(value);
      };
      const timeout = setTimeout(() => finish({ _tag: "Timeout" }), timeoutMs);
      timeout.unref();
      pending.add(finish);
      this.waiters.set(threadId, pending);
    });
  }

  private resolveThread(threadId: string, value: OwnerWaitResult): void {
    const pending = this.waiters.get(threadId);
    if (pending == null) return;
    this.waiters.delete(threadId);
    for (const resolve of pending) resolve(value);
  }

  private resolveWaiters(value: OwnerWaitResult): void {
    for (const threadId of [...this.waiters.keys()]) {
      this.resolveThread(threadId, value);
    }
  }
}
