import type { Logger } from "../logger.js";
import type { WireNotification } from "./rpc.js";

export class NotificationFanout {
  private readonly listeners = new Set<
    (message: WireNotification) => void
  >();

  constructor(private readonly logger: Logger) {}

  subscribe(listener: (message: WireNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message: WireNotification): void {
    const listeners = [...this.listeners];
    queueMicrotask(() => {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          this.logger.warn("app_server_notification_listener_failed", {
            method: message.method,
          });
        }
      }
    });
  }
}
