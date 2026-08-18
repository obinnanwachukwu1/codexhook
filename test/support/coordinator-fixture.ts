import {
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import {
  LocalDeliveryCoordinator,
  type DeliveryRequest,
} from "../../src/contracts/delivery.js";
import {
  Desktop,
  type DesktopProtocol,
  type DesktopSession,
} from "../../src/contracts/desktop.js";
import { sanitizeDiagnostic } from "../../src/contracts/diagnostics.js";
import {
  LocalCodex,
  type LocalCodexService,
  type LocalTaskEvent,
  type LocalTaskRef,
} from "../../src/contracts/local-codex.js";
import type { RouteSubmissionOutcome } from "../../src/contracts/submission.js";
import { LocalDeliveryCoordinatorLive } from "../../src/delivery/coordinator.js";
import { DeliveryId, ThreadId, TurnId } from "../../src/types.js";

const desktopCompatibility = {
  status: "compatible" as const,
  plane: "desktop-ipc" as const,
  major: 1,
  revision: 1,
  features: [] as const,
};
const appCompatibility = {
  status: "compatible" as const,
  plane: "app-server" as const,
  major: 2,
  revision: 1,
  features: [] as const,
};

export function task(id = "thread-1"): LocalTaskRef {
  return { threadId: ThreadId(id), origin: "cli" } as LocalTaskRef;
}

export function request(
  localTask = task(),
  id = "delivery-1",
  mode: "queue" | "steer" = "steer",
  idleTimeout: Duration.DurationInput = "50 millis",
): DeliveryRequest {
  return {
    task: localTask,
    deliveryId: DeliveryId(id),
    message: "review this",
    mode,
    idleTimeout: Duration.decode(idleTimeout),
    turnTimeout: Duration.decode("500 millis"),
  };
}

function confirmed(
  route: "desktop" | "app-server",
  input: Pick<DeliveryRequest, "deliveryId" | "mode">,
): RouteSubmissionOutcome {
  return {
    _tag: "Confirmed",
    route,
    deliveryId: input.deliveryId,
    turnId: TurnId(`${route}-turn`),
    operation: input.mode === "queue" ? "start" : "steer",
  };
}

export function diagnostic(
  code: "desktop-unavailable" | "request-rejected" | "write-ambiguous" |
    "app-server-unavailable",
  route: "desktop" | "app-server",
) {
  return sanitizeDiagnostic({
    code,
    stage: route === "desktop" ? "submit-desktop" : "submit-app-server",
    route,
  });
}

export function snapshot(
  input: DeliveryRequest,
  deliveryIds: ReadonlyArray<DeliveryId> = [],
): LocalTaskEvent {
  return {
    type: "snapshot",
    history: {
      task: input.task,
      turns: [{
        id: TurnId("observed-turn"),
        status: "completed",
        deliveryIds,
      }],
    },
  };
}

export interface CoordinatorFixtureOptions {
  desktopFollow?: DesktopSession["follow"];
  desktopSubmit?: DesktopSession["submit"];
  desktopAvailability?: DesktopProtocol["availability"];
  localSubmit?: LocalCodexService["submit"];
  events?: LocalCodexService["events"];
  activeTurnId?: TurnId | null;
  onAcquire?: () => void;
  onRelease?: () => void;
}

export function coordinatorRuntime(options: CoordinatorFixtureOptions = {}) {
  const session: DesktopSession = {
    compatibility: desktopCompatibility,
    follow: options.desktopFollow ?? ((localTask) => {
      const activeTurnId = options.activeTurnId === undefined
        ? TurnId("active-turn")
        : options.activeTurnId;
      return Effect.succeed(activeTurnId == null
        ? { task: localTask, activity: "idle" as const, activeTurnId: null }
        : { task: localTask, activity: "active" as const, activeTurnId });
    }),
    submit: options.desktopSubmit ?? ((input) => Effect.succeed({
      ...confirmed("desktop", input),
      route: "desktop" as const,
    } as RouteSubmissionOutcome<"desktop">)),
  };
  const desktop = Desktop.of({
    availability: options.desktopAvailability ?? Effect.succeed({
      status: "available",
      compatibility: desktopCompatibility,
    }),
    connect: Effect.acquireRelease(
      Effect.sync(() => {
        options.onAcquire?.();
        return session;
      }),
      () => Effect.sync(() => options.onRelease?.()),
    ),
  } satisfies DesktopProtocol);
  const local = LocalCodex.of({
    availability: Effect.succeed({
      status: "available",
      compatibility: appCompatibility,
    }),
    listTasks: Effect.die("unused"),
    readHistory: () => Effect.die("unused"),
    resolveTask: () => Effect.die("unused"),
    events: options.events ?? ((input) => Stream.succeed({
      type: "snapshot",
      history: { task: input, turns: [] },
    })),
    submit: options.localSubmit ?? ((input) => Effect.succeed({
      _tag: "Confirmed",
      route: "app-server",
      deliveryId: input.deliveryId,
      turnId: TurnId("app-server-turn"),
      operation: input.mode === "queue" ? "start" : "steer",
    })),
  } satisfies LocalCodexService);
  return ManagedRuntime.make(LocalDeliveryCoordinatorLive.pipe(Layer.provide(
    Layer.merge(
      Layer.succeed(Desktop, desktop),
      Layer.succeed(LocalCodex, local),
    ),
  )));
}

export async function deliver(
  service: ReturnType<typeof coordinatorRuntime>,
  input: DeliveryRequest,
) {
  return service.runPromise(Effect.flatMap(
    LocalDeliveryCoordinator,
    (coordinator) => coordinator.deliver(input),
  ));
}
