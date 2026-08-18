import { Duration, Effect, Layer, Option, Scope } from "effect";
import {
  checkProtocolCompatibility,
  type CompatibleProtocol,
  type ProtocolAvailability,
  type ProtocolFeature,
  type ProtocolOffer,
  type ProtocolRequirement,
} from "../contracts/compatibility.js";
import {
  Desktop,
  type DesktopFailure,
  type DesktopProtocol,
  type DesktopSession,
  type DesktopSubmissionRequest,
} from "../contracts/desktop.js";
import { sanitizeDiagnostic } from "../contracts/diagnostics.js";
import type { RouteSubmissionOutcome } from "../contracts/submission.js";
import { TurnId } from "../types.js";
import { DesktopAttachment } from "./desktop-attachment.js";
import {
  DesktopProtocolError,
  DesktopProtocolSession,
  type DesktopProtocolProfile,
} from "./desktop-ipc/index.js";
import { DesktopIpcProtocol } from "./desktop-task-protocol.js";
import {
  TransportProvider,
  type TransportProviderService,
} from "./provider.js";
import type { TransportSpec } from "./spec.js";

type DesktopSpec = Extract<TransportSpec, { readonly _tag: "Desktop" }>;

export const DESKTOP_REQUIREMENT: ProtocolRequirement = {
  plane: "desktop-ipc",
  major: 1,
  minimumRevision: 1,
  requiredFeatures: [
    "task-follow",
    "task-history",
    "task-events",
    "turn-start",
    "turn-steer",
    "delivery-id",
  ],
};

function diagnostic(
  code: "desktop-unavailable" | "desktop-incompatible" | "desktop-not-following" |
    "write-ambiguous" | "request-rejected" | "internal",
  stage: "probe-desktop" | "connect-desktop" | "follow-desktop" |
    "submit-desktop",
  protocolRevision?: number,
) {
  return sanitizeDiagnostic({
    code,
    stage,
    route: "desktop",
    ...(protocolRevision == null ? {} : { protocolRevision }),
  });
}

function failure(
  code: "desktop-unavailable" | "desktop-incompatible" | "desktop-not-following" |
    "internal",
  stage: "probe-desktop" | "connect-desktop" | "follow-desktop",
): DesktopFailure {
  return { _tag: "DesktopFailure", diagnostic: diagnostic(code, stage) };
}

export function desktopOffer(profile: DesktopProtocolProfile): ProtocolOffer {
  const features: ProtocolFeature[] = [];
  if (profile.capabilities.threadStream) {
    features.push("task-follow", "task-events");
  }
  if (profile.capabilities.completeHistory) features.push("task-history");
  if (profile.capabilities.startTurn) features.push("turn-start");
  if (profile.capabilities.steerTurn) features.push("turn-steer");
  if (
    profile.capabilities.startTurn &&
    profile.capabilities.steerTurn
  ) features.push("delivery-id");
  return {
    plane: "desktop-ipc",
    major: profile.compatibility.major,
    revision: profile.compatibility.revision,
    features,
  };
}

function compatible(profile: DesktopProtocolProfile): CompatibleProtocol | null {
  const result = checkProtocolCompatibility(
    DESKTOP_REQUIREMENT,
    desktopOffer(profile),
  );
  return result.status === "compatible" ? result : null;
}

function unavailableFrom(cause: unknown): ProtocolAvailability {
  const incompatible = cause instanceof DesktopProtocolError && [
    "frame-invalid",
    "handshake-malformed",
    "response-malformed",
    "unknown-protocol-version",
    "unsupported-capability",
  ].includes(cause.failure);
  return {
    status: incompatible ? "incompatible" : "unavailable",
    diagnostic: diagnostic(
      incompatible ? "desktop-incompatible" : "desktop-unavailable",
      "probe-desktop",
    ),
  };
}

function openProtocol(
  spec: DesktopSpec,
): Effect.Effect<
  { readonly attachment: DesktopAttachment; readonly profile: DesktopProtocolProfile },
  DesktopFailure,
  Scope.Scope
> {
  return Effect.suspend(() => {
    let acquired: DesktopAttachment | null = null;
    const open = Effect.tryPromise({
      try: (signal) => DesktopIpcProtocol.connect(
        spec.socketPath,
        signal,
      ),
      catch: (cause) => failure(
        cause instanceof DesktopProtocolError && [
          "handshake-malformed",
          "unknown-protocol-version",
          "unsupported-capability",
        ].includes(cause.failure)
          ? "desktop-incompatible"
          : "desktop-unavailable",
        "connect-desktop",
      ),
    });
    return Effect.acquireReleaseInterruptible(
      open.pipe(Effect.map((protocol) => {
        const attachment = new DesktopAttachment(protocol);
        acquired = attachment;
        return { attachment, profile: protocol.profile };
      })),
      () => Effect.sync(() => acquired?.close()),
    );
  });
}

function routeOutcome(
  request: DesktopSubmissionRequest,
  result: Awaited<ReturnType<DesktopAttachment["inject"]>>,
): RouteSubmissionOutcome<"desktop"> {
  if (result._tag === "Confirmed") {
    return {
      _tag: "Confirmed",
      route: "desktop",
      deliveryId: request.deliveryId,
      turnId: TurnId(result.turnId),
      operation: request.mode === "queue" ? "start" : "steer",
    };
  }
  if (result._tag === "NotSubmitted") {
    return {
      _tag: "NotSubmitted",
      route: "desktop",
      deliveryId: request.deliveryId,
      reason: result.submissionReason ?? "pre-submit-failure",
      diagnostic: diagnostic("desktop-not-following", "submit-desktop"),
    };
  }
  if (result._tag === "Rejected") {
    return {
      _tag: "Rejected",
      route: "desktop",
      deliveryId: request.deliveryId,
      diagnostic: diagnostic("request-rejected", "submit-desktop"),
    };
  }
  return {
    _tag: "Ambiguous",
    route: "desktop",
    deliveryId: request.deliveryId,
    diagnostic: diagnostic("write-ambiguous", "submit-desktop"),
  };
}

function desktopSession(
  attachment: DesktopAttachment,
  compatibility: CompatibleProtocol,
): DesktopSession {
  return {
    compatibility,
    follow: (task) => Effect.tryPromise({
      try: async () => {
        await attachment.resume(task.threadId);
        const state = attachment.state(task.threadId);
        const active = state.turns.filter(
          (turn) => turn.status === "inProgress",
        );
        if (active.length > 1) throw new Error("multiple-active-turns");
        return {
          task,
          activeTurnId: active[0] == null ? null : TurnId(active[0].id),
        };
      },
      catch: () => failure("desktop-not-following", "follow-desktop"),
    }),
    submit: (request) => Effect.uninterruptible(
      Effect.tryPromise({
        try: () => attachment.inject(request.mode === "queue"
          ? {
              kind: "start",
              threadId: request.task.threadId,
              clientUserMessageId: request.deliveryId,
              input: [{ type: "text", text: request.message }],
              timeoutMs: Duration.toMillis(request.replyTimeout),
            }
          : {
              kind: "steer",
              threadId: request.task.threadId,
              expectedTurnId: request.expectedTurnId,
              clientUserMessageId: request.deliveryId,
              input: [{ type: "text", text: request.message }],
              timeoutMs: Duration.toMillis(request.replyTimeout),
            }),
        catch: () => null,
      }).pipe(Effect.match({
        onFailure: () => ({
            _tag: "Ambiguous" as const,
            route: "desktop" as const,
            deliveryId: request.deliveryId,
            diagnostic: diagnostic("internal", "submit-desktop"),
          }),
        onSuccess: (result) => routeOutcome(request, result),
      })),
    ),
  };
}

export function desktopProtocolService(
  provider: TransportProviderService,
): DesktopProtocol {
  return {
    availability: provider.desktopCandidate.pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.succeed({
          status: "unavailable" as const,
          diagnostic: diagnostic("desktop-unavailable", "probe-desktop"),
        }),
        onSome: (candidate) => Effect.tryPromise({
          try: () => DesktopProtocolSession.probe(candidate.socketPath),
          catch: (cause) => cause,
        }).pipe(Effect.map((profile): ProtocolAvailability => {
          const value = compatible(profile);
          return value == null
            ? {
                status: "incompatible",
                diagnostic: diagnostic(
                  "desktop-incompatible",
                  "probe-desktop",
                  profile.compatibility.revision,
                ),
              }
            : { status: "available", compatibility: value };
        }), Effect.catchAll((cause) => Effect.succeed(unavailableFrom(cause)))),
      })),
      Effect.catchAll(() => Effect.succeed({
        status: "incompatible" as const,
        diagnostic: diagnostic("desktop-incompatible", "probe-desktop"),
      })),
    ),
    connect: provider.desktopCandidate.pipe(
      Effect.mapError(() => failure("desktop-incompatible", "connect-desktop")),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(
          failure("desktop-unavailable", "connect-desktop"),
        ),
        onSome: openProtocol,
      })),
      Effect.flatMap(({ attachment, profile }) => {
        const value = compatible(profile);
        return value == null
          ? Effect.fail(failure("desktop-incompatible", "connect-desktop"))
          : Effect.succeed(desktopSession(attachment, value));
      }),
    ),
  };
}

export const DesktopProtocolLive = Layer.effect(
  Desktop,
  Effect.map(TransportProvider, desktopProtocolService),
);
