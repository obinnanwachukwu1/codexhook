export type DaemonPhase = "starting" | "ready" | "draining" | "stopped";

export interface LifecycleSnapshot {
  readonly phase: DaemonPhase;
  readonly accepting: boolean;
  readonly activeRequests: number;
}

export class ServiceLifecycle {
  private phase: DaemonPhase = "starting";
  private activeRequests = 0;
  private readonly idleWaiters = new Set<() => void>();

  ready(): void {
    if (this.phase !== "starting") {
      throw new Error(`cannot become ready from ${this.phase}`);
    }
    this.phase = "ready";
  }

  enter(): (() => void) | null {
    if (this.phase !== "ready") return null;
    this.activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }

  beginDrain(): boolean {
    if (this.phase === "draining" || this.phase === "stopped") return false;
    this.phase = "draining";
    return true;
  }

  stopped(): void {
    this.phase = "stopped";
  }

  snapshot(): LifecycleSnapshot {
    return {
      phase: this.phase,
      accepting: this.phase === "ready",
      activeRequests: this.activeRequests,
    };
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.activeRequests === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      this.idleWaiters.add(onIdle);
    });
  }
}
