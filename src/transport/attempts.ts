import { Effect } from "effect";
import {
  NO_DIAGNOSTICS,
  recordDiagnostic,
  type DiagnosticObserver,
} from "../diagnostics/contracts.js";
import {
  attemptFailedEvent,
  canonicalFoundEvent,
  canonicalUnknownEvent,
  desktopConnectedEvent,
  fallbackAttemptedEvent,
  fallbackSelectedEvent,
} from "../diagnostics/events.js";
import { Logger } from "../logger.js";
import type {
  TransportId,
  TurnOutcome,
  TurnRequest,
} from "../types.js";
import {
  type DeliveryError,
  isTryNext,
  NoTransportAvailable,
} from "./errors.js";
import type { DesktopVisibility } from "./desktop-visibility.js";
import type { TransportSpec } from "./spec.js";

export type TransportAttemptStage =
  | "connect"
  | "resume"
  | "follow"
  | "submit"
  | "await"
  | "refresh";

export interface TransportAttemptFailure {
  readonly transport: TransportId;
  readonly stage: TransportAttemptStage;
  readonly errorTag: DeliveryError["_tag"];
  readonly detail: string;
  readonly elapsedMs: number;
}

export interface TransportAttemptRunner {
  readonly run: (
    candidate: TransportSpec,
    setStage: (stage: TransportAttemptStage) => void,
  ) => Effect.Effect<TurnOutcome, DeliveryError>;
  readonly confirmDesktopVisibility: (
    outcome: TurnOutcome,
    setStage: (stage: TransportAttemptStage) => void,
  ) => Effect.Effect<DesktopVisibility, DeliveryError>;
}

function errorDetail(error: DeliveryError): string {
  if (error._tag === "SubmitAmbiguous") {
    return `${error.method}:${error.cause}`;
  }
  if (error._tag === "SubmitRejected") {
    return `${error.method}:${error.code}:${error.message}`;
  }
  if (error._tag === "ThreadBusy") {
    return `thread busy for ${error.waitedMillis}ms`;
  }
  if (error._tag === "TurnTimeout") {
    return `turn timed out after ${error.waitedMillis}ms`;
  }
  if (error._tag === "TurnFailed") {
    return `turn ${error.status}`;
  }
  if ("detail" in error && typeof error.detail === "string") {
    return error.detail;
  }
  if ("message" in error && typeof error.message === "string") {
    return error.message;
  }
  if ("cause" in error && typeof error.cause === "string") {
    return error.cause;
  }
  return error._tag;
}

function attemptFields(
  request: TurnRequest,
  transport: TransportId,
  stage: TransportAttemptStage,
  elapsedMs: number,
) {
  return {
    deliveryId: request.deliveryId,
    threadId: request.threadId,
    transport,
    stage,
    elapsedMs,
  };
}

export function deliverWithFallback(
  request: TurnRequest,
  candidates: ReadonlyArray<TransportSpec>,
  runner: TransportAttemptRunner,
  logger: Logger,
  diagnostics: DiagnosticObserver = NO_DIAGNOSTICS,
): Effect.Effect<TurnOutcome, DeliveryError> {
  const attempt = (
    remaining: ReadonlyArray<TransportSpec>,
    failures: ReadonlyArray<TransportAttemptFailure>,
  ): Effect.Effect<TurnOutcome, DeliveryError> => {
    const candidate = remaining[0];
    if (candidate == null) {
      return Effect.fail(new NoTransportAvailable({ attempts: failures }));
    }

    let stage: TransportAttemptStage = "connect";
    const startedAt = Date.now();
    logger.info("transport_attempt_started", {
      deliveryId: request.deliveryId,
      threadId: request.threadId,
      transport: candidate.id,
      stage,
    });
    return runner.run(candidate, (next) => {
      stage = next;
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const elapsedMs = Date.now() - startedAt;
          const failure: TransportAttemptFailure = {
            transport: candidate.id,
            stage,
            errorTag: error._tag,
            detail: errorDetail(error),
            elapsedMs,
          };
          const tryNext = isTryNext(error);
          logger.warn("transport_attempt_failed", {
            ...attemptFields(
              request,
              candidate.id,
              stage,
              elapsedMs,
            ),
            errorTag: error._tag,
            detail: failure.detail,
            tryNext,
          });
          recordDiagnostic(
            diagnostics,
            attemptFailedEvent(candidate.id, stage, error),
          );
          if (tryNext) {
            recordDiagnostic(diagnostics, fallbackAttemptedEvent(candidate.id));
          }
          if (!tryNext) return Effect.fail(error);
          return attempt(
            remaining.slice(1),
            [...failures, failure],
          );
        },
        onSuccess: (outcome) => {
          const elapsedMs = Date.now() - startedAt;
          logger.info("transport_attempt_succeeded", {
            ...attemptFields(
              request,
              candidate.id,
              stage,
              elapsedMs,
            ),
            status: outcome._tag,
          });
          if (candidate._tag === "Desktop") {
            recordDiagnostic(diagnostics, desktopConnectedEvent());
            if (failures.length > 0) {
              recordDiagnostic(
                diagnostics,
                fallbackSelectedEvent(outcome.transport),
              );
            }
            logger.info("transport_selected", {
              deliveryId: request.deliveryId,
              threadId: request.threadId,
              transport: outcome.transport,
              priorFailures: failures.length,
              desktopVisibility: "not-required",
            });
            return Effect.succeed(outcome);
          }

          let refreshStage: TransportAttemptStage = "refresh";
          const refreshStartedAt = Date.now();
          logger.info("desktop_visibility_started", {
            deliveryId: request.deliveryId,
            threadId: request.threadId,
            transport: "desktop",
            turnId: outcome.turnId,
          });
          return runner
            .confirmDesktopVisibility(outcome, (next) => {
              refreshStage = next;
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  logger.error("desktop_visibility_failed", {
                    ...attemptFields(
                      request,
                      "desktop",
                      refreshStage,
                      Date.now() - refreshStartedAt,
                    ),
                    turnId: outcome.turnId,
                    errorTag: error._tag,
                    detail: errorDetail(error),
                    submittedTransport: outcome.transport,
                  });
                  recordDiagnostic(diagnostics, canonicalUnknownEvent("failed"));
                }),
              ),
              Effect.tap((visibility) =>
                Effect.sync(() => {
                  logger.info(
                    visibility === "confirmed"
                      ? "desktop_visibility_confirmed"
                      : "desktop_visibility_deferred",
                    {
                      ...attemptFields(
                        request,
                        "desktop",
                        refreshStage,
                        Date.now() - refreshStartedAt,
                      ),
                      turnId: outcome.turnId,
                      submittedTransport: outcome.transport,
                      reason:
                        visibility === "deferred"
                          ? "desktop-unavailable"
                          : undefined,
                    },
                  );
                  recordDiagnostic(
                    diagnostics,
                    visibility === "confirmed"
                      ? canonicalFoundEvent()
                      : canonicalUnknownEvent("deferred"),
                  );
                  if (failures.length > 0) {
                    recordDiagnostic(
                      diagnostics,
                      fallbackSelectedEvent(outcome.transport),
                    );
                  }
                  logger.info("transport_selected", {
                    deliveryId: request.deliveryId,
                    threadId: request.threadId,
                    transport: outcome.transport,
                    priorFailures: failures.length,
                    desktopVisibility: visibility,
                  });
                }),
              ),
              Effect.as(outcome),
            );
        },
      }),
    );
  };

  return attempt(candidates, []);
}
