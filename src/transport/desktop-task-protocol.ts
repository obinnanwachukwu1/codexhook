import {
  DesktopProtocolError,
  DesktopProtocolSession,
  type DesktopKnownRejection,
  type DesktopProtocolProfile,
  type DesktopProtocolSessionOptions,
} from "./desktop-ipc/index.js";
import { readDesktopChange } from "./desktop-task-decoder.js";
import type { Turn } from "./protocol.js";

export interface DesktopTurnEntity {
  readonly key: string;
  readonly turn: Turn;
}

export interface DesktopDeliveryBinding {
  readonly key: string;
  readonly deliveryId: string;
}

export type DesktopTurnDelta =
  | { readonly _tag: "Upsert"; readonly entity: DesktopTurnEntity }
  | { readonly _tag: "Bind"; readonly key: string; readonly turnId: string }
  | {
      readonly _tag: "Status";
      readonly key: string;
      readonly status: Turn["status"];
    }
  | {
      readonly _tag: "Error";
      readonly key: string;
      readonly error: Turn["error"];
    }
  | { readonly _tag: "Remove"; readonly key: string };

export type DesktopTaskChange =
  | {
      readonly _tag: "Snapshot";
      readonly revision: number | null;
      readonly entities: ReadonlyArray<DesktopTurnEntity>;
      readonly deliveryIds: ReadonlyArray<string>;
      readonly deliveryBindings?: ReadonlyArray<DesktopDeliveryBinding>;
    }
  | {
      readonly _tag: "Patches";
      readonly baseRevision: number | null;
      readonly revision: number | null;
      readonly deltas: ReadonlyArray<DesktopTurnDelta>;
      readonly deliveryIds: ReadonlyArray<string>;
      readonly deliveryBindings?: ReadonlyArray<DesktopDeliveryBinding>;
    };

export type DesktopCommand =
  | {
      readonly kind: "start";
      readonly threadId: string;
      readonly clientUserMessageId: string;
      readonly input: unknown;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "steer";
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly clientUserMessageId: string;
      readonly input: unknown;
      readonly timeoutMs?: number;
    };

export type DesktopCommandReply =
  | {
      readonly _tag: "Accepted";
      readonly result: unknown;
      readonly turnId: string | null;
    }
  | {
      readonly _tag: "Rejected";
      readonly reason: string;
      readonly notWritten: boolean;
      readonly confirmedNoSubmission?: boolean;
    };

/** Connection-scoped seam consumed by semantic task attachment. */
export interface DesktopTaskProtocol {
  readonly connected: boolean;
  readonly profile?: DesktopProtocolProfile;
  readonly close: () => void;
  readonly follow: (threadId: string) => Promise<void>;
  readonly inject: (
    command: DesktopCommand,
  ) => Promise<DesktopCommandReply>;
  readonly loadHistory: (threadId: string) => Promise<boolean>;
  readonly onChange: (
    listener: (threadId: string, change: DesktopTaskChange) => void,
  ) => () => void;
  readonly onConnection: (
    listener: (event: "Disconnected" | "Reconnected" | "Reconnecting") => void,
  ) => () => void;
}

export class DesktopIpcProtocol implements DesktopTaskProtocol {
  private readonly changes = new Set<
    (threadId: string, change: DesktopTaskChange) => void
  >();
  private readonly connections = new Set<
    (event: "Disconnected" | "Reconnected" | "Reconnecting") => void
  >();

  private closed = false;
  private readonly removeBroadcast: () => void;
  private readonly removeObservation: () => void;

  private constructor(private readonly session: DesktopProtocolSession) {
    this.removeBroadcast = session.onBroadcast((message) => {
      const event = readDesktopChange(message);
      if (event == null) return;
      for (const listener of this.changes) {
        listener(event.threadId, event.change);
      }
    });
    this.removeObservation = session.onObservation((observation) => {
      if (
        observation._tag !== "Disconnected" &&
        observation._tag !== "Reconnected" &&
        observation._tag !== "Reconnecting"
      ) return;
      for (const listener of this.connections) listener(observation._tag);
    });
  }

  static async connect(
    socketPath: string,
    signal?: AbortSignal,
    onCreate?: (protocol: DesktopIpcProtocol) => void,
    options: DesktopProtocolSessionOptions = {},
  ): Promise<DesktopIpcProtocol> {
    let protocol: DesktopIpcProtocol | null = null;
    await DesktopProtocolSession.connect(
      socketPath,
      options,
      signal,
      (session) => {
        protocol = new DesktopIpcProtocol(session);
        onCreate?.(protocol);
      },
    );
    if (protocol == null) {
      throw new Error("Desktop IPC protocol was not created");
    }
    return protocol;
  }

  get connected(): boolean {
    return !this.closed && this.session.alive;
  }

  get profile(): DesktopProtocolProfile {
    return this.session.profile;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeBroadcast();
    this.removeObservation();
    this.session.close();
  }

  async follow(threadId: string): Promise<void> {
    await this.session.followThread(threadId);
  }

  async loadHistory(threadId: string): Promise<boolean> {
    const reply = await this.session.loadCompleteHistory(
      threadId,
      this.session.requestTimeout(30_000),
    );
    return reply.outcome._tag === "Accepted";
  }

  async inject(command: DesktopCommand): Promise<DesktopCommandReply> {
    try {
      const timeoutMs = this.session.requestTimeout(
        command.timeoutMs ?? 30_000,
      );
      const reply = command.kind === "start"
        ? await this.session.startTurn(
            command.threadId,
            commandParams(command),
            timeoutMs,
          )
        : await this.session.steerTurn(
            command.threadId,
            commandParams(command),
            timeoutMs,
          );
      if (reply.outcome._tag === "Rejected") {
        return rejection(reply.outcome.rejection);
      }
      return {
        _tag: "Accepted",
        result: reply.outcome.value,
        turnId: reply.outcome.value.turnId,
      };
    } catch (cause) {
      if (
        cause instanceof DesktopProtocolError &&
        cause.writeState === "not-written"
      ) {
        return {
          _tag: "Rejected",
          reason: cause.failure,
          notWritten: true,
        };
      }
      throw cause;
    }
  }

  onChange(
    listener: (threadId: string, change: DesktopTaskChange) => void,
  ): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  onConnection(
    listener: (event: "Disconnected" | "Reconnected" | "Reconnecting") => void,
  ): () => void {
    this.connections.add(listener);
    return () => this.connections.delete(listener);
  }
}

function commandParams(command: DesktopCommand) {
  if (command.kind === "start") {
    return {
      clientUserMessageId: command.clientUserMessageId,
      input: command.input,
    };
  }
  const prompt = inputText(command.input);
  return {
    expectedTurnId: command.expectedTurnId,
    clientUserMessageId: command.clientUserMessageId,
    input: command.input,
    restoreMessage: {
      id: command.clientUserMessageId,
      text: prompt,
      context: {
        prompt,
        addedFiles: [],
        fileAttachments: [],
        ideContext: null,
        imageAttachments: [],
        workspaceRoots: [],
      },
      cwd: null,
      createdAt: Date.now(),
    },
  };
}

function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  const item = input.find((value) =>
    value != null &&
    typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "text" &&
    typeof (value as { readonly text?: unknown }).text === "string"
  ) as { readonly text: string } | undefined;
  return item?.text ?? "";
}

function rejection(reason: DesktopKnownRejection): DesktopCommandReply {
  return {
    _tag: "Rejected",
    reason,
    notWritten: reason !== "unknown",
    confirmedNoSubmission: reason !== "unknown",
  };
}
