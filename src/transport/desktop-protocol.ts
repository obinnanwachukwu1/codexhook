import {
  DesktopIpcClient,
  type IpcEnvelope,
} from "./desktop-ipc-client.js";

const IPC_VERSION = {
  following: 1,
  history: 1,
  interrupt: 1,
  start: 1,
  steer: 1,
} as const;

export type DesktopChange = {
  readonly type?: string;
  readonly baseRevision?: number;
  readonly revision?: number;
  readonly conversationState?: unknown;
  readonly patches?: ReadonlyArray<{
    readonly op?: string;
    readonly path?: ReadonlyArray<string | number>;
    readonly value?: unknown;
  }>;
};

export interface DesktopCommand {
  readonly kind: "start" | "steer" | "interrupt";
  readonly threadId: string;
  readonly expectedTurnId?: string;
  readonly clientUserMessageId?: string;
  readonly input?: unknown;
}

export type DesktopCommandReply =
  | { readonly _tag: "Accepted"; readonly result: unknown }
  | {
      readonly _tag: "Rejected";
      readonly reason: string;
      readonly retrySafe: boolean;
    };

/** Semantic boundary used by task attachment; it contains no IPC framing. */
export interface DesktopProtocol {
  readonly connected: boolean;
  readonly close: () => void;
  readonly follow: (threadId: string) => Promise<void>;
  readonly inject: (
    command: DesktopCommand,
  ) => Promise<DesktopCommandReply>;
  readonly loadHistory: (threadId: string) => Promise<void>;
  readonly onChange: (
    listener: (threadId: string, change: DesktopChange) => void,
  ) => () => void;
  readonly onDisconnect: (
    listener: (error: Error) => void,
  ) => () => void;
}

export type DesktopProtocolConnector = () => Promise<DesktopProtocol>;

function safeRejection(error: string): boolean {
  return [
    "no-client-found",
    "client-not-found",
    "client-cannot-handle-request",
    "request-version-mismatch",
    "no-handler-for-request",
    "thread stream owner became unavailable",
    "thread-role-timeout",
  ].some((value) => error.includes(value));
}

function readChange(
  message: IpcEnvelope,
): { readonly threadId: string; readonly change: DesktopChange } | null {
  if (
    message.method !== "thread-stream-state-changed" ||
    message.params == null ||
    typeof message.params !== "object"
  ) return null;
  const params = message.params as {
    readonly conversationId?: unknown;
    readonly change?: unknown;
  };
  if (
    typeof params.conversationId !== "string" ||
    params.change == null ||
    typeof params.change !== "object"
  ) return null;
  return {
    threadId: params.conversationId,
    change: params.change as DesktopChange,
  };
}

export class DesktopIpcProtocol implements DesktopProtocol {
  private readonly changes = new Set<
    (threadId: string, change: DesktopChange) => void
  >();
  private readonly disconnects = new Set<(error: Error) => void>();

  private constructor(private readonly client: DesktopIpcClient) {
    client.onBroadcast((message) => {
      const event = readChange(message);
      if (event == null) return;
      for (const listener of this.changes) {
        listener(event.threadId, event.change);
      }
    });
    client.onDisconnect((error) => {
      for (const listener of this.disconnects) listener(error);
    });
  }

  static async connect(socketPath: string): Promise<DesktopIpcProtocol> {
    return new DesktopIpcProtocol(
      await DesktopIpcClient.connect(socketPath),
    );
  }

  get connected(): boolean {
    return this.client.alive;
  }

  close(): void {
    this.client.close();
  }

  async follow(threadId: string): Promise<void> {
    this.client.broadcast(
      "thread-stream-following-changed",
      { conversationId: threadId, hostId: "local", following: true },
      IPC_VERSION.following,
    );
  }

  async loadHistory(threadId: string): Promise<void> {
    const reply = await this.client.request(
      "thread-follower-load-complete-history",
      { conversationId: threadId },
      IPC_VERSION.history,
      30_000,
    );
    if (reply.resultType === "error") {
      throw new Error(reply.error ?? "Desktop history request failed");
    }
  }

  async inject(command: DesktopCommand): Promise<DesktopCommandReply> {
    const method = `thread-follower-${command.kind}-turn`;
    const params = command.kind === "start"
      ? {
          conversationId: command.threadId,
          turnStartParams: {
            clientUserMessageId: command.clientUserMessageId,
            input: command.input,
          },
        }
      : {
          conversationId: command.threadId,
          turnId: command.expectedTurnId,
          clientUserMessageId: command.clientUserMessageId,
          input: command.input,
        };
    const reply = await this.client.request(
      method,
      params,
      IPC_VERSION[command.kind],
      30_000,
    );
    if (reply.resultType === "error") {
      const reason = reply.error ?? "Desktop rejected the request";
      return {
        _tag: "Rejected",
        reason,
        retrySafe: safeRejection(reason),
      };
    }
    const outer = reply.result as
      | { readonly result?: unknown }
      | undefined;
    return { _tag: "Accepted", result: outer?.result };
  }

  onChange(
    listener: (threadId: string, change: DesktopChange) => void,
  ): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }
}
