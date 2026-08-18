import { Data, Deferred, Duration, Effect, Schema } from "effect";
import type { TurnId } from "../types.js";
import type { AppServerInfo, Turn } from "./protocol.js";
import type { TransportSpec } from "./spec.js";

export class RpcNotWritten extends Data.TaggedError("RpcNotWritten")<{
  readonly detail: string;
}> {}

export class RpcWriteAmbiguous extends Data.TaggedError(
  "RpcWriteAmbiguous",
)<{
  readonly detail: string;
}> {}

export class RpcErrorReply extends Data.TaggedError("RpcErrorReply")<{
  readonly code: number;
  readonly message: string;
}> {}

export class RpcDisconnected extends Data.TaggedError("RpcDisconnected")<{
  readonly detail: string;
}> {}

export class RpcTimeout extends Data.TaggedError("RpcTimeout")<{
  readonly millis: number;
}> {}

export class RpcMalformed extends Data.TaggedError("RpcMalformed")<{
  readonly detail: string;
}> {}

export interface RpcTicket {
  readonly id: string;
  readonly method: string;
  readonly serialized: string;
  readonly reply: Deferred.Deferred<
    unknown,
    RpcErrorReply | RpcDisconnected
  >;
}

export interface AppServerPeer {
  readonly spec: TransportSpec;
  /** Present only for a real app-server peer with a compatible initialize reply. */
  readonly serverInfo: AppServerInfo | null;
  readonly isAlive: Effect.Effect<boolean>;
  readonly onNotification: (
    listener: (message: WireNotification) => void,
  ) => () => void;
  readonly notify: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void, RpcNotWritten | RpcWriteAmbiguous>;
  /** Allocates the reply slot and serializes the request without writing bytes. */
  readonly prepare: (
    method: string,
    params: unknown,
  ) => Effect.Effect<RpcTicket, RpcNotWritten>;
  /** Calling this method crosses the submission barrier. */
  readonly submit: (
    ticket: RpcTicket,
  ) => Effect.Effect<void, RpcNotWritten | RpcWriteAmbiguous>;
  readonly reply: <A, I>(
    ticket: RpcTicket,
    schema: Schema.Schema<A, I>,
    timeout: Duration.DurationInput,
  ) => Effect.Effect<
    A,
    RpcErrorReply | RpcDisconnected | RpcTimeout | RpcMalformed
  >;
  readonly request: <A, I>(
    method: string,
    params: unknown,
    schema: Schema.Schema<A, I>,
    timeout: Duration.DurationInput,
  ) => Effect.Effect<
    A,
    | RpcNotWritten
    | RpcWriteAmbiguous
    | RpcErrorReply
    | RpcDisconnected
    | RpcTimeout
    | RpcMalformed
  >;
  readonly awaitTurn: (
    turnId: TurnId,
    timeout: Duration.DurationInput,
  ) => Effect.Effect<Turn, RpcDisconnected | RpcTimeout>;
}

export interface WireConnection {
  readonly input: NodeJS.ReadableStream;
  readonly isAlive: () => boolean;
  readonly write: (
    serialized: string,
    callback: (error?: Error | null) => void,
  ) => void;
  readonly onError: (listener: (error: Error) => void) => void;
  readonly onExit: (
    listener: (code: number | null, signal: string | null) => void,
  ) => void;
  readonly onStderr?: (listener: (chunk: string) => void) => void;
}

export interface WireMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

export interface WireNotification {
  readonly method: string;
  readonly params?: unknown;
}
