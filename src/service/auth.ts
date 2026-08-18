import type { IncomingMessage } from "node:http";
import type { WebhookRecord } from "../types.js";

export type AuthorizationTarget =
  | { readonly kind: "health" }
  | {
      readonly kind: "webhook";
      readonly hook: WebhookRecord;
    }
  | { readonly kind: "service"; readonly operation: string };

export interface RequestAuthenticator {
  readonly authorize: (
    request: IncomingMessage,
    target: AuthorizationTarget,
  ) => boolean | Promise<boolean>;
}

/**
 * Webhook capability tokens remain the default authentication boundary. This
 * seam lets a future local adapter add stronger service-level authentication
 * without teaching the HTTP listener about that adapter's protocol.
 */
export const capabilityTokenAuthenticator: RequestAuthenticator = {
  authorize: () => true,
};
