import { Context, Effect, Stream } from "effect";
import {
  ThreadId,
  type DeliveryId,
  type DeliveryMode,
  type TurnId,
} from "../types.js";
import type {
  ProtocolCompatibility,
  ProtocolOffer,
} from "./compatibility.js";
import { sanitizeDiagnostic } from "./diagnostics.js";
import type { SanitizedDiagnostic } from "./diagnostics.js";
import type { RouteSubmissionOutcome } from "./submission.js";

export type TaskOrigin = "desktop" | "cli" | "unknown";

export interface TaskProvenance {
  readonly scope: "local";
  readonly store: "codex";
  readonly hostId: "local";
  readonly discoveredVia: "app-server";
  readonly origin: TaskOrigin;
}

export interface LocalTaskRef {
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
}

export interface LocalTaskHistory {
  readonly task: LocalTaskRef;
  readonly turns: ReadonlyArray<LocalTurn>;
  readonly cursor: string | null;
}

export type LocalTaskEvent =
  | {
      readonly type: "snapshot";
      readonly task: LocalTaskRef;
      readonly history: LocalTaskHistory;
      readonly cursor: string;
    }
  | {
      readonly type: "turn-changed";
      readonly task: LocalTaskRef;
      readonly turn: LocalTurn;
      readonly cursor: string;
    }
  | {
      readonly type: "task-removed";
      readonly task: LocalTaskRef;
      readonly cursor: string;
    };

export type LocalCodexAvailability =
  | {
      readonly status: "available";
      readonly offer: ProtocolOffer;
      readonly compatibility: Extract<
        ProtocolCompatibility,
        { readonly status: "compatible" }
      >;
    }
  | {
      readonly status: "unavailable" | "incompatible";
      readonly diagnostic: SanitizedDiagnostic;
    };

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
  readonly readHistory: (
    task: LocalTaskRef,
  ) => Effect.Effect<LocalTaskHistory, LocalCodexFailure>;
  readonly events: (
    task: LocalTaskRef,
    afterCursor?: string,
  ) => Stream.Stream<LocalTaskEvent, LocalCodexFailure>;
  readonly submit: (
    request: LocalSubmissionRequest,
  ) => Effect.Effect<RouteSubmissionOutcome<"app-server">>;
}

export class LocalCodex extends Context.Tag("codexhook/LocalCodex")<
  LocalCodex,
  LocalCodexService
>() {}

export function localTaskRef(
  threadId: ThreadId,
  origin: TaskOrigin = "unknown",
): LocalTaskRef {
  return {
    threadId,
    provenance: {
      scope: "local",
      store: "codex",
      hostId: "local",
      discoveredVia: "app-server",
      origin,
    },
  };
}

export type LocalTaskValidation =
  | { readonly ok: true; readonly task: LocalTaskRef }
  | {
      readonly ok: false;
      readonly diagnostic: SanitizedDiagnostic;
    };

export function validateLocalTask(value: unknown): LocalTaskValidation {
  if (value == null || typeof value !== "object") {
    return { ok: false, diagnostic: notLocal() };
  }
  const task = value as Partial<LocalTaskRef>;
  const provenance = task.provenance as
    | Partial<TaskProvenance>
    | undefined;
  const local = typeof task.threadId === "string" &&
    provenance?.scope === "local" &&
    provenance.store === "codex" &&
    provenance.hostId === "local" &&
    provenance.discoveredVia === "app-server" &&
    (provenance.origin === "desktop" ||
      provenance.origin === "cli" ||
      provenance.origin === "unknown");
  return local
    ? {
        ok: true,
        task: localTaskRef(
          ThreadId(task.threadId as string),
          provenance.origin as TaskOrigin,
        ),
      }
    : { ok: false, diagnostic: notLocal() };
}

function notLocal(): SanitizedDiagnostic {
  return sanitizeDiagnostic({ code: "task-not-local", stage: "resolve-task" });
}
