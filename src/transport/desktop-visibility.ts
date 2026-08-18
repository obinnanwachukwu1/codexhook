import { Duration, Effect } from "effect";
import type { TurnOutcome } from "../types.js";
import {
  DesktopVisibilityUnconfirmed,
  TransportUnavailable,
} from "./errors.js";
import type { TransportProviderService } from "./provider.js";
import { ThreadResumeResult } from "./protocol.js";
import { RpcTimeout } from "./rpc.js";

const REFRESH_TIMEOUT = Duration.seconds(30);

export type DesktopVisibility = "confirmed" | "deferred";

export function confirmDesktopVisibility(
  provider: TransportProviderService,
  outcome: TurnOutcome,
): Effect.Effect<DesktopVisibility, DesktopVisibilityUnconfirmed> {
  if (outcome.transport === "desktop") {
    return Effect.succeed("confirmed");
  }
  const submittedTransport = outcome.transport;
  return Effect.scoped(
    Effect.gen(function* () {
      const candidate = yield* provider.desktopCandidate;
      if (candidate._tag === "None") return null;
      const desktop = candidate.value;
      const peer = yield* provider.connect(desktop);
      if (outcome._tag === "Steered") {
        const alive = yield* peer.isAlive;
        if (!alive) return null;
        return yield* new DesktopVisibilityUnconfirmed({
          threadId: outcome.threadId,
          turnId: outcome.turnId,
          submittedTransport,
          reason: "steer-unverified",
          detail:
            "Desktop cannot verify fallback input steered into an existing turn",
        });
      }
      return yield* Effect.gen(function* () {
        const resumed = yield* peer.request(
          "thread/resume",
          { threadId: outcome.threadId },
          ThreadResumeResult,
          REFRESH_TIMEOUT,
        );
        const visibleTurn = resumed.thread.turns.find(
          (turn) => turn.id === outcome.turnId,
        );
        if (visibleTurn?.status === "completed") return visibleTurn;
        return yield* peer.awaitTurn(outcome.turnId, REFRESH_TIMEOUT).pipe(
          Effect.catchIf(
            (error) => visibleTurn == null && error instanceof RpcTimeout,
            () =>
              Effect.fail(
                new DesktopVisibilityUnconfirmed({
                  threadId: outcome.threadId,
                  turnId: outcome.turnId,
                  submittedTransport,
                  reason: "turn-not-exposed",
                  detail:
                    "Desktop did not expose the completed fallback turn",
                }),
              ),
          ),
        );
      }).pipe(
        Effect.catchAll((error) =>
          peer.isAlive.pipe(
            Effect.flatMap((alive) =>
              alive ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        ),
      );
    }),
  ).pipe(
    Effect.flatMap((turn) =>
      turn == null
        ? Effect.succeed("deferred" as const)
        : turn.id === outcome.turnId && turn.status === "completed"
          ? Effect.succeed("confirmed" as const)
          : Effect.fail(
              new DesktopVisibilityUnconfirmed({
                threadId: outcome.threadId,
                turnId: outcome.turnId,
                submittedTransport,
                reason: "refresh-failed",
                detail:
                  "Desktop exposed the fallback turn without confirming completion",
              }),
            ),
    ),
    Effect.catchIf(
      (error) =>
        error instanceof TransportUnavailable &&
        error.reason === "not-running",
      () => Effect.succeed("deferred" as const),
    ),
    Effect.mapError((error) =>
      error instanceof DesktopVisibilityUnconfirmed
        ? error
        : new DesktopVisibilityUnconfirmed({
            threadId: outcome.threadId,
            turnId: outcome.turnId,
            submittedTransport,
            reason: "refresh-failed",
            detail:
              "detail" in error && typeof error.detail === "string"
                ? error.detail
                : "Desktop could not refresh the submitted turn",
          }),
    ),
  );
}
