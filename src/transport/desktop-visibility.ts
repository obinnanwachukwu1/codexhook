import { Duration, Effect } from "effect";
import type { TurnOutcome } from "../types.js";
import { DesktopVisibilityUnconfirmed } from "./errors.js";
import type { TransportProviderService } from "./provider.js";
import { ThreadResumeResult } from "./protocol.js";
import type { TransportSpec } from "./spec.js";

const REFRESH_TIMEOUT = Duration.seconds(30);

export function confirmDesktopVisibility(
  provider: TransportProviderService,
  desktop: Extract<TransportSpec, { readonly _tag: "Desktop" }>,
  outcome: TurnOutcome,
): Effect.Effect<void, DesktopVisibilityUnconfirmed> {
  if (outcome.transport === "desktop") return Effect.void;
  const submittedTransport = outcome.transport;
  return Effect.scoped(
    provider.connect(desktop).pipe(
      Effect.flatMap((peer) =>
        peer.request(
          "thread/resume",
          { threadId: outcome.threadId },
          ThreadResumeResult,
          REFRESH_TIMEOUT,
        ),
      ),
    ),
  ).pipe(
    Effect.flatMap((result) =>
      result.thread.turns.some((turn) => turn.id === outcome.turnId)
        ? Effect.void
        : Effect.fail(
            new DesktopVisibilityUnconfirmed({
              threadId: outcome.threadId,
              turnId: outcome.turnId,
              submittedTransport,
              detail:
                "Desktop followed the task but did not expose the submitted turn",
            }),
          ),
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
