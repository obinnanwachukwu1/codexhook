import { Effect } from "effect";
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
    desktop: Extract<TransportSpec, { readonly _tag: "Desktop" }>,
    outcome: TurnOutcome,
    setStage: (stage: TransportAttemptStage) => void,
  ) => Effect.Effect<void, DeliveryError>;
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

function desktopFailureNeedsRefresh(
  candidate: TransportSpec,
  stage: TransportAttemptStage,
  error: DeliveryError,
): boolean {
  return !(
    candidate._tag !== "Desktop" ||
    (stage === "connect" &&
      error._tag === "TransportUnavailable" &&
      error.reason === "not-running")
  );
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
): Effect.Effect<TurnOutcome, DeliveryError> {
  const desktop = candidates.find(
    (candidate): candidate is Extract<
      TransportSpec,
      { readonly _tag: "Desktop" }
    > => candidate._tag === "Desktop",
  );

  const attempt = (
    remaining: ReadonlyArray<TransportSpec>,
    failures: ReadonlyArray<TransportAttemptFailure>,
    desktopNeedsRefresh: boolean,
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
          if (!tryNext) return Effect.fail(error);
          return attempt(
            remaining.slice(1),
            [...failures, failure],
            desktopNeedsRefresh ||
              desktopFailureNeedsRefresh(candidate, stage, error),
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
          if (
            desktop == null ||
            candidate._tag === "Desktop" ||
            !desktopNeedsRefresh
          ) {
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
            transport: desktop.id,
            turnId: outcome.turnId,
          });
          return runner
            .confirmDesktopVisibility(desktop, outcome, (next) => {
              refreshStage = next;
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  logger.error("desktop_visibility_failed", {
                    ...attemptFields(
                      request,
                      desktop.id,
                      refreshStage,
                      Date.now() - refreshStartedAt,
                    ),
                    turnId: outcome.turnId,
                    errorTag: error._tag,
                    detail: errorDetail(error),
                    submittedTransport: outcome.transport,
                  });
                }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  logger.info("desktop_visibility_confirmed", {
                    ...attemptFields(
                      request,
                      desktop.id,
                      refreshStage,
                      Date.now() - refreshStartedAt,
                    ),
                    turnId: outcome.turnId,
                    submittedTransport: outcome.transport,
                  });
                  logger.info("transport_selected", {
                    deliveryId: request.deliveryId,
                    threadId: request.threadId,
                    transport: outcome.transport,
                    priorFailures: failures.length,
                    desktopVisibility: "confirmed",
                  });
                }),
              ),
              Effect.as(outcome),
            );
        },
      }),
    );
  };

  return attempt(candidates, [], false);
}
