import { Duration, Effect } from "effect";
import type { TurnOutcome } from "../types.js";
import {
  DesktopVisibilityUnconfirmed,
  TransportUnavailable,
} from "./errors.js";
import type { TransportProviderService } from "./provider.js";
import { ThreadResumeResult } from "./protocol.js";

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
          detail:
            "Desktop cannot verify fallback input steered into an existing turn",
        });
      }
      return yield* peer.request(
        "thread/resume",
        { threadId: outcome.threadId },
        ThreadResumeResult,
        REFRESH_TIMEOUT,
      ).pipe(
        Effect.zipRight(
          peer.awaitTurn(outcome.threadId, outcome.turnId, REFRESH_TIMEOUT),
        ),
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
                detail:
                  "Desktop did not expose the completed fallback turn",
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
            detail:
              "detail" in error && typeof error.detail === "string"
                ? error.detail
                : "Desktop could not refresh the submitted turn",
          }),
    ),
  );
}
