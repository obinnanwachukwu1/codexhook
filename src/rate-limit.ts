export class ThreadRateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 60_000,
  ) {}

  allow(threadId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    for (const [id, timestamps] of this.events) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) this.events.delete(id);
      else if (active.length !== timestamps.length) this.events.set(id, active);
    }
    const recent = (this.events.get(threadId) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= this.limit) {
      this.events.set(threadId, recent);
      return false;
    }
    recent.push(now);
    this.events.set(threadId, recent);
    return true;
  }
}
