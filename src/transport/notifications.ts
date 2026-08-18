import type { Logger } from "../logger.js";
import type { WireNotification } from "./rpc.js";

export class NotificationFanout {
  private readonly listeners = new Set<{
    readonly onMessage: (message: WireNotification) => void;
    readonly onClose: () => void;
    active: boolean;
  }>();
  private closed = false;

  constructor(private readonly logger: Logger) {}

  subscribe(
    onMessage: (message: WireNotification) => void,
    onClose: () => void,
  ): () => void {
    if (this.closed) {
      queueMicrotask(onClose);
      return () => undefined;
    }
    const subscription = { onMessage, onClose, active: true };
    this.listeners.add(subscription);
    return () => {
      subscription.active = false;
      this.listeners.delete(subscription);
    };
  }

  publish(message: WireNotification): void {
    if (this.listeners.size === 0) return;
    const listeners = [...this.listeners];
    queueMicrotask(() => {
      for (const subscription of listeners) {
        if (!subscription.active || !this.listeners.has(subscription)) continue;
        try {
          subscription.onMessage(message);
        } catch {
          this.logger.warn("app_server_notification_listener_failed", {
            method: message.method.slice(0, 200),
          });
        }
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    queueMicrotask(() => {
      for (const subscription of listeners) {
        if (!subscription.active) continue;
        try {
          subscription.onClose();
        } catch {
          this.logger.warn("app_server_notification_close_listener_failed");
        }
      }
    });
  }
}
