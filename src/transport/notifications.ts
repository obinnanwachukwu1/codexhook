import type { Logger } from "../logger.js";
import type { WireNotification } from "./rpc.js";

export function publishNotification(
  listeners: ReadonlySet<(message: WireNotification) => void>,
  message: WireNotification,
  logger: Logger,
): void {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (cause) {
      logger.warn("app_server_notification_listener_failed", {
        method: message.method,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
