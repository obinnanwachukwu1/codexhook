import { DesktopIpcClient } from "./desktop-ipc-client.js";
import {
  nestedTurnId,
  readDesktopChange,
} from "./desktop-task-decoder.js";
import type { Turn } from "./protocol.js";

const IPC_VERSION = {
  following: 1,
  history: 1,
  interrupt: 1,
  start: 1,
  steer: 1,
} as const;

export interface DesktopTurnEntity {
  readonly key: string;
  readonly turn: Turn;
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
    }
  | {
      readonly _tag: "Patches";
      readonly baseRevision: number | null;
      readonly revision: number | null;
      readonly deltas: ReadonlyArray<DesktopTurnDelta>;
      readonly deliveryIds: ReadonlyArray<string>;
    };

export type DesktopCommand =
  | {
      readonly kind: "start";
      readonly threadId: string;
      readonly clientUserMessageId: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "steer";
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly clientUserMessageId: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "interrupt";
      readonly threadId: string;
      readonly expectedTurnId: string;
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
    };

/** Connection-scoped seam consumed by semantic task attachment. */
export interface DesktopTaskProtocol {
  readonly connected: boolean;
  readonly close: () => void;
  readonly follow: (threadId: string) => Promise<void>;
  readonly inject: (
    command: DesktopCommand,
  ) => Promise<DesktopCommandReply>;
  readonly loadHistory: (threadId: string) => Promise<void>;
  readonly onChange: (
    listener: (threadId: string, change: DesktopTaskChange) => void,
  ) => () => void;
  readonly onDisconnect: (
    listener: (error: Error) => void,
  ) => () => void;
}

export type DesktopProtocolConnector = () => Promise<DesktopTaskProtocol>;

const METHODS = {
  interrupt: "thread-follower-interrupt-turn",
  start: "thread-follower-start-turn",
  steer: "thread-follower-steer-turn",
} as const;

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

export class DesktopIpcProtocol implements DesktopTaskProtocol {
  private readonly changes = new Set<
    (threadId: string, change: DesktopTaskChange) => void
  >();
  private readonly disconnects = new Set<(error: Error) => void>();

  private constructor(private readonly client: DesktopIpcClient) {
    client.onBroadcast((message) => {
      const event = readDesktopChange(message);
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
    const reply = await this.client.request(
      METHODS[command.kind],
      commandParams(command),
      IPC_VERSION[command.kind],
      30_000,
    );
    if (reply.resultType === "error") {
      const reason = reply.error ?? "Desktop rejected the request";
      return {
        _tag: "Rejected",
        reason,
        notWritten: safeRejection(reason),
      };
    }
    const outer = reply.result as
      | { readonly result?: unknown }
      | undefined;
    return {
      _tag: "Accepted",
      result: outer?.result,
      turnId: nestedTurnId(outer?.result),
    };
  }

  onChange(
    listener: (threadId: string, change: DesktopTaskChange) => void,
  ): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }
}

function commandParams(command: DesktopCommand): unknown {
  if (command.kind === "start") {
    return {
      conversationId: command.threadId,
      turnStartParams: {
        clientUserMessageId: command.clientUserMessageId,
        input: command.input,
      },
    };
  }
  if (command.kind === "steer") {
    return {
      conversationId: command.threadId,
      expectedTurnId: command.expectedTurnId,
      clientUserMessageId: command.clientUserMessageId,
      input: command.input,
    };
  }
  return {
    conversationId: command.threadId,
    turnId: command.expectedTurnId,
  };
}
