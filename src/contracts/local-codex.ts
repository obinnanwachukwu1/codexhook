import { Context, type Effect, type Stream } from "effect";
import type {
  DeliveryId,
  DeliveryMode,
  ThreadId,
  TurnId,
} from "../types.js";
import type { ProtocolAvailability } from "./compatibility.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";
import type { RouteSubmissionOutcome } from "./submission.js";

export type TaskOrigin = "desktop" | "cli" | "unknown";

declare const localTaskRefBrand: unique symbol;

export interface TaskProvenance {
  readonly scope: "local";
  readonly origin: TaskOrigin;
}

export interface LocalTaskRef {
  readonly [localTaskRefBrand]: true;
  readonly threadId: ThreadId;
  readonly provenance: TaskProvenance;
}

export interface LocalTaskSummary extends LocalTaskRef {
  readonly title: string | null;
  readonly updatedAt: number;
}

export interface LocalTurn {
  readonly id: TurnId;
  readonly status: "completed" | "interrupted" | "failed" | "in-progress";
  readonly deliveryIds: ReadonlyArray<DeliveryId>;
}

export interface LocalTaskHistory {
  readonly task: LocalTaskRef;
  readonly turns: ReadonlyArray<LocalTurn>;
}

export type LocalTaskEvent =
  | {
      readonly type: "snapshot";
      readonly task: LocalTaskRef;
      readonly history: LocalTaskHistory;
    }
  | {
      readonly type: "turn-changed";
      readonly task: LocalTaskRef;
      readonly turn: LocalTurn;
    }
  | {
      readonly type: "task-removed";
      readonly task: LocalTaskRef;
    };

export type LocalCodexAvailability = ProtocolAvailability;

export interface LocalSubmissionRequest {
  readonly task: LocalTaskRef;
  readonly deliveryId: DeliveryId;
  readonly mode: DeliveryMode;
  readonly message: string;
}

export interface LocalCodexFailure {
  readonly _tag: "LocalCodexFailure";
  readonly diagnostic: SanitizedDiagnostic;
}

export interface LocalCodexService {
  readonly availability: Effect.Effect<LocalCodexAvailability>;
  readonly listTasks: Effect.Effect<
    ReadonlyArray<LocalTaskSummary>,
    LocalCodexFailure
  >;
  /** Point-in-time history for display and inspection, not reconciliation. */
  readonly readHistory: (
    task: LocalTaskRef,
  ) => Effect.Effect<LocalTaskHistory, LocalCodexFailure>;
  /** Resolve only through the canonical local app-server. */
  readonly resolveTask: (
    threadId: ThreadId,
  ) => Effect.Effect<LocalTaskRef, LocalCodexFailure>;
  /**
   * Snapshot-first canonical stream. Reconciliation must use this stream,
   * never a readHistory-then-subscribe sequence.
   */
  readonly events: (
    task: LocalTaskRef,
  ) => Stream.Stream<LocalTaskEvent, LocalCodexFailure>;
  /**
   * The possible-write region is uninterruptible. Convert every non-fatal
   * failure or defect into an outcome; any uncertain write becomes Ambiguous.
   */
  readonly submit: (
    request: LocalSubmissionRequest,
  ) => Effect.Effect<RouteSubmissionOutcome<"app-server">>;
}

export class LocalCodex extends Context.Tag("codexhook/LocalCodex")<
  LocalCodex,
  LocalCodexService
>() {}
