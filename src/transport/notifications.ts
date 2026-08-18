import { Deferred, Effect } from "effect";
import type { AppServerNotification, RpcDisconnected } from "./rpc.js";

export class AppServerNotifications {
  private readonly observers = new Set<
    (notification: AppServerNotification) => void
  >();

  emit(method: string | undefined, params: unknown): Effect.Effect<void> {
    if (method == null) return Effect.void;
    return Effect.sync(() => {
      for (const observer of this.observers) {
        try {
          observer({ method, params });
        } catch {
          // Observers cannot affect RPC delivery or connection health.
        }
      }
    });
  }

  observe(
    disconnected: Deferred.Deferred<never, RpcDisconnected>,
    listener: (notification: AppServerNotification) => void,
  ): Effect.Effect<never, RpcDisconnected> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.observers.add(listener)),
      () => Deferred.await(disconnected),
      () => Effect.sync(() => this.observers.delete(listener)),
    );
  }
}
