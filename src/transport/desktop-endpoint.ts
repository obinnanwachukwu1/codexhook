import { lstat, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Option } from "effect";
import { DesktopProtocolSession } from "./desktop-protocol/index.js";
import { TransportIncompatible } from "./errors.js";
import type { TransportSpec } from "./spec.js";

type DesktopSpec = Extract<
  TransportSpec,
  { readonly _tag: "Desktop" }
>;

type EndpointState = "absent" | "private" | "unsafe";

function socketPath(): string {
  return process.env.CODEXHOOK_DESKTOP_IPC_PATH ??
    (process.platform === "win32"
      ? "\\\\.\\pipe\\codex-ipc"
      : path.join(os.homedir(), ".codex", "ipc", "ipc.sock"));
}

function spec(): DesktopSpec {
  return {
    _tag: "Desktop",
    id: "desktop",
    socketPath: socketPath(),
    approvals: "decline",
  };
}

async function endpointState(
  desktopSocketPath: string,
): Promise<EndpointState> {
  if (process.platform === "win32") return "private";
  try {
    const [info, parent] = await Promise.all([
      lstat(desktopSocketPath),
      stat(path.dirname(desktopSocketPath)),
    ]);
    return (
      info.isSocket() &&
      !info.isSymbolicLink() &&
      process.getuid?.() === info.uid &&
      (info.mode & 0o077) === 0 &&
      parent.isDirectory() &&
      parent.uid === info.uid &&
      (parent.mode & 0o077) === 0
    )
      ? "private"
      : "unsafe";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return "absent";
    throw cause;
  }
}

export async function desktopSocketIsPrivate(
  desktopSocketPath: string,
): Promise<boolean> {
  try {
    return await endpointState(desktopSocketPath) === "private";
  } catch {
    return false;
  }
}

export const desktopVisibilityCandidate: Effect.Effect<
  Option.Option<DesktopSpec>,
  TransportIncompatible
> = Effect.tryPromise({
  try: async () => {
    const candidate = spec();
    return {
      candidate,
      state: await endpointState(candidate.socketPath),
    };
  },
  catch: (cause) =>
    new TransportIncompatible({
      transport: "desktop",
      stage: "capabilities",
      detail: cause instanceof Error ? cause.message : String(cause),
    }),
}).pipe(
  Effect.flatMap(({ candidate, state }) =>
    state === "absent"
      ? Effect.succeed(Option.none())
      : state === "private"
        ? Effect.succeed(Option.some(candidate))
        : Effect.fail(
            new TransportIncompatible({
              transport: "desktop",
              stage: "capabilities",
              detail: "Desktop IPC endpoint is not private",
            }),
          ),
  ),
);

export const desktopProbe: Effect.Effect<Option.Option<DesktopSpec>> =
  desktopVisibilityCandidate.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (candidate) =>
          Effect.tryPromise(async () => {
            await DesktopProtocolSession.probe(candidate.socketPath);
            return Option.some(candidate);
          }),
      }),
    ),
    Effect.catchAll(() => Effect.succeed(Option.none())),
  );
