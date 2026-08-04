import { Duration, Effect } from "effect";
import type { TurnOutcome } from "../types.js";
import {
  DesktopVisibilityUnconfirmed,
  TransportUnavailable,
} from "./errors.js";
import type { TransportProviderService } from "./provider.js";
import { ThreadResumeResult } from "./protocol.js";
import type { TransportSpec } from "./spec.js";

const REFRESH_TIMEOUT = Duration.seconds(30);

export type DesktopVisibility = "confirmed" | "deferred";

export function confirmDesktopVisibility(
  provider: TransportProviderService,
  desktop: Extract<TransportSpec, { readonly _tag: "Desktop" }>,
  outcome: TurnOutcome,
): Effect.Effect<DesktopVisibility, DesktopVisibilityUnconfirmed> {
  if (outcome.transport === "desktop") {
    return Effect.succeed("confirmed");
  }
  const submittedTransport = outcome.transport;
  if (outcome._tag === "Steered") {
    return Effect.fail(
      new DesktopVisibilityUnconfirmed({
        threadId: outcome.threadId,
        turnId: outcome.turnId,
        submittedTransport,
        detail:
          "Desktop cannot verify fallback input steered into an existing turn",
      }),
    );
  }
  return Effect.scoped(
    provider.connect(desktop).pipe(
      Effect.flatMap((peer) =>
        peer.request(
          "thread/resume",
          { threadId: outcome.threadId },
          ThreadResumeResult,
          REFRESH_TIMEOUT,
        ).pipe(
          Effect.zipRight(
            peer.awaitTurn(outcome.turnId, REFRESH_TIMEOUT),
          ),
        ),
      ),
    ),
  ).pipe(
    Effect.flatMap((turn) =>
      turn.id === outcome.turnId && turn.status === "completed"
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
