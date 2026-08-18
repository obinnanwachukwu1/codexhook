import { Writable } from "node:stream";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Option,
} from "effect";
import { Logger } from "../../src/logger.js";
import type { DiagnosticEvent } from "../../src/diagnostics/contracts.js";
import { Delivery, DeliveryLive } from "../../src/delivery/delivery.js";
import {
  DeliveryId,
  ThreadId,
  type TurnRequest,
  type WebhookRecord,
} from "../../src/types.js";
import { TransportUnavailable } from "../../src/transport/errors.js";
import {
  TransportProvider,
  type TransportProviderService,
} from "../../src/transport/provider.js";
import type { TransportSpec } from "../../src/transport/spec.js";
import {
  CodexTransport,
  makeCodexTransportLive,
} from "../../src/transport/transport.js";
import {
  fakeTransportPeer,
  type PeerRecorder,
  type WriteBehavior,
} from "./fake-transport-peer.js";
export type { WriteBehavior } from "./fake-transport-peer.js";

export interface Recorder extends PeerRecorder {
  readonly diagnostics: DiagnosticEvent[];
  readonly logs: Array<Record<string, unknown>>;
  readonly opens: string[];
  readonly writes: Array<{ transport: string; method: string }>;
  completedTurnId: string | null;
  live: number;
  maxLive: number;
}

export interface TransportFixture {
  readonly layer: Layer.Layer<TransportProvider>;
  readonly logger: Logger;
  readonly recorder: Recorder;
}

const bundled: TransportSpec = {
  _tag: "ChildProcess",
  id: "app-bundled",
  executable: "/fake/bundled",
  args: [],
  approvals: "decline",
};

const cli: TransportSpec = {
  _tag: "ChildProcess",
  id: "cli",
  executable: "/fake/cli",
  args: [],
  approvals: "decline",
};

export const desktop: Extract<
  TransportSpec,
  { readonly _tag: "Desktop" }
> = {
  _tag: "Desktop",
  id: "desktop",
  socketPath: "/fake/ipc.sock",
  approvals: "decline",
};

export const daemon: TransportSpec = {
  _tag: "UnixSocket",
  id: "daemon",
  socketPath: "/fake/app-server.sock",
  approvals: "decline",
};

export function fakeProvider(
  scripts: Readonly<Record<string, WriteBehavior>>,
  candidates: ReadonlyArray<TransportSpec> = [bundled, cli],
): TransportFixture {
  const recorder: Recorder = {
    diagnostics: [],
    logs: [],
    opens: [],
    writes: [],
    completedTurnId: null,
    live: 0,
    maxLive: 0,
  };
  const logger = new Logger(
    new Writable({
      write(chunk, _encoding, callback) {
        recorder.logs.push(JSON.parse(String(chunk)));
        callback();
      },
    }),
  );
  const service: TransportProviderService = {
    candidates: Effect.succeed(candidates),
    desktopCandidate: Effect.sync(() => {
      const behavior = scripts.desktop;
      const known =
        behavior != null ||
        candidates.some((candidate) => candidate._tag === "Desktop");
      const closed =
        behavior === "connect-fail" ||
        (behavior === "follow-fail-then-close" &&
          recorder.opens.includes("desktop"));
      return known && !closed
        ? Option.some(desktop)
        : Option.none();
    }),
    connect: (spec) => {
      const behavior = scripts[spec.id];
      const closedAfterFirstConnection =
        behavior === "follow-fail-then-close" &&
        recorder.opens.includes(spec.id);
      if (behavior === "connect-handshake-fail") {
        return Effect.fail(
          new TransportUnavailable({
            transport: spec.id,
            reason: "handshake-timeout",
            detail: "Desktop initialize timed out",
          }),
        );
      }
      if (behavior === "connect-fail" || closedAfterFirstConnection) {
        return Effect.fail(
          new TransportUnavailable({
            transport: spec.id,
            reason: "not-running",
            detail: "Desktop closed after discovery",
          }),
        );
      }
      return Effect.acquireRelease(
        Effect.sync(() => {
          recorder.opens.push(spec.id);
          recorder.live += 1;
          recorder.maxLive = Math.max(recorder.maxLive, recorder.live);
          const ordinal = recorder.opens.filter(
            (opened) => opened === spec.id,
          ).length;
          return fakeTransportPeer(
            spec,
            scripts[spec.id] ?? "ok",
            recorder,
            ordinal,
          );
        }),
        () =>
          Effect.sync(() => {
            recorder.live -= 1;
          }),
      );
    },
  };
  return {
    layer: Layer.succeed(TransportProvider, service),
    logger,
    recorder,
  };
}

function request(mode: "queue" | "steer"): TurnRequest {
  return {
    threadId: ThreadId("thread-1"),
    deliveryId: DeliveryId("delivery-1"),
    message: "hello",
    mode,
    idleTimeout: "1 second",
    turnTimeout: "1 second",
  };
}

function diagnosticObserver(fixture: TransportFixture) {
  return { record: (event: DiagnosticEvent) =>
    fixture.recorder.diagnostics.push(event) };
}
function delivery(fixture: TransportFixture, mode: "queue" | "steer") {
  return Effect.scoped(
    Effect.flatMap(CodexTransport, (transport) =>
      transport.deliver(request(mode)),
    ).pipe(
      Effect.provide(
        makeCodexTransportLive(fixture.logger, diagnosticObserver(fixture)),
      ),
      Effect.provide(fixture.layer),
    ),
  );
}

export function runTransport(
  fixture: TransportFixture,
  mode: "queue" | "steer" = "queue",
) {
  return Effect.runPromise(delivery(fixture, mode));
}

export function runTransportExit(
  fixture: TransportFixture,
  mode: "queue" | "steer" = "queue",
) {
  return Effect.runPromiseExit(delivery(fixture, mode));
}

export async function runDelivery(
  fixture: TransportFixture,
  mode: "queue" | "steer" = "queue",
): Promise<void> {
  const diagnostics = diagnosticObserver(fixture);
  const appLayer = DeliveryLive(fixture.logger, diagnostics).pipe(
    Layer.provideMerge(makeCodexTransportLive(fixture.logger, diagnostics)),
    Layer.provide(fixture.layer),
  );
  const runtime = ManagedRuntime.make(appLayer);
  const hook: WebhookRecord = {
    id: "fixture",
    threadId: ThreadId("thread-1"),
    mode,
    prependBody: "",
    expiresAt: null,
    remainingDeliveries: null,
    createdAt: Date.now(),
  };
  try {
    await runtime.runPromise(Effect.flatMap(Delivery, (service) =>
      service.submit(hook, "hello")));
    const deadline = Date.now() + 1_000;
    while (!hasTerminalLog(fixture) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!hasTerminalLog(fixture)) throw new Error("delivery fixture timed out");
  } finally {
    await runtime.dispose();
  }
}

function hasTerminalLog(fixture: TransportFixture): boolean {
  return fixture.recorder.logs.some(({ event }) =>
    event === "delivery_failed" || event === "delivery_finished");
}
