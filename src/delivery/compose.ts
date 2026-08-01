import type { WebhookRecord } from "../types.js";

export function composeMessage(hook: WebhookRecord, body: string): string {
  return `${hook.prependBody.replaceAll("{hookId}", hook.id)}${body}`;
}
