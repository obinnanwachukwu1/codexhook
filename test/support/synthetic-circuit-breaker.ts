import type { DiagnosticObserver } from "../../src/diagnostics/contracts.js";
import { circuitBreakerEvent } from "../../src/diagnostics/events.js";

type BreakerState = "closed" | "open" | "half-open";

/** Synthetic integration fixture; production routing owns no breaker here. */
export class SyntheticCircuitBreaker {
  private state: BreakerState = "closed";

  constructor(private readonly diagnostics: DiagnosticObserver) {}

  fail(): void {
    if (this.state !== "closed") throw new Error("breaker is not closed");
    this.state = "open";
    this.diagnostics.record(circuitBreakerEvent("opened"));
  }

  probe(): void {
    if (this.state !== "open") throw new Error("breaker is not open");
    this.state = "half-open";
    this.diagnostics.record(circuitBreakerEvent("half-open"));
  }

  recover(): void {
    if (this.state !== "half-open") throw new Error("breaker is not probing");
    this.state = "closed";
    this.diagnostics.record(circuitBreakerEvent("recovered"));
  }
}
