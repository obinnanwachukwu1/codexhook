import net from "node:net";
import { PassThrough } from "node:stream";
import { Effect, Scope } from "effect";
import WebSocket from "ws";
import { Logger } from "../logger.js";
import {
  TransportIncompatible,
  TransportUnavailable,
} from "./errors.js";
import {
  connectWirePeer,
} from "./peer.js";
import type { AppServerPeer, WireConnection } from "./rpc.js";
import type { TransportSpec } from "./spec.js";

interface OpenSocket {
  readonly webSocket: WebSocket;
  readonly input: PassThrough;
  readonly connection: WireConnection;
}

function openSocket(
  spec: Extract<TransportSpec, { readonly _tag: "UnixSocket" }>,
): Effect.Effect<OpenSocket, TransportUnavailable> {
  return Effect.async<OpenSocket, TransportUnavailable>((resume) => {
    const input = new PassThrough();
    const webSocket = new WebSocket("ws://localhost/rpc", {
      createConnection: () => net.createConnection(spec.socketPath),
      perMessageDeflate: false,
    });

    const fail = (error: Error) => {
      resume(
        Effect.fail(
          new TransportUnavailable({
            transport: spec.id,
            reason: "spawn-failed",
            detail: error.message,
          }),
        ),
      );
    };

    webSocket.once("error", fail);
    webSocket.once("open", () => {
      webSocket.off("error", fail);
      webSocket.on("message", (data) => {
        input.write(data);
        input.write("\n");
      });
      const connection: WireConnection = {
        input,
        isAlive: () => webSocket.readyState === WebSocket.OPEN,
        write: (serialized, callback) => {
          webSocket.send(serialized.trimEnd(), callback);
        },
        onError: (listener) => {
          webSocket.once("error", listener);
        },
        onExit: (listener) => {
          webSocket.once("close", () => listener(0, null));
        },
      };
      resume(Effect.succeed({ webSocket, input, connection }));
    });

    return Effect.sync(() => {
      webSocket.off("error", fail);
      webSocket.terminate();
      input.destroy();
    });
  });
}

function closeSocket(socket: OpenSocket): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    const { webSocket } = socket;
    socket.input.destroy();
    if (
      webSocket.readyState === WebSocket.CLOSED ||
      webSocket.readyState === WebSocket.CLOSING
    ) {
      resume(Effect.void);
      return;
    }
    const timeout = setTimeout(() => {
      webSocket.terminate();
      resume(Effect.void);
    }, 2_000);
    webSocket.once("close", () => {
      clearTimeout(timeout);
      resume(Effect.void);
    });
    webSocket.close();
  }).pipe(Effect.uninterruptible);
}

export function connectUnixPeer(
  spec: Extract<TransportSpec, { readonly _tag: "UnixSocket" }>,
  logger = new Logger(),
): Effect.Effect<
  AppServerPeer,
  TransportUnavailable | TransportIncompatible,
  Scope.Scope
> {
  return Effect.acquireRelease(openSocket(spec), closeSocket).pipe(
    Effect.flatMap(({ connection }) =>
      connectWirePeer(spec, connection, logger),
    ),
  );
}
