import { Brand, Duration } from "effect";

export type ThreadId = string & Brand.Brand<"ThreadId">;
export const ThreadId = Brand.nominal<ThreadId>();

export type TurnId = string & Brand.Brand<"TurnId">;
export const TurnId = Brand.nominal<TurnId>();

export type DeliveryId = string & Brand.Brand<"DeliveryId">;
export const DeliveryId = Brand.nominal<DeliveryId>();

export type DeliveryMode = "queue" | "steer";
export type TransportId = "desktop" | "daemon" | "app-bundled" | "cli";

export interface WebhookRecord {
  id: string;
  threadId: ThreadId;
  mode: DeliveryMode;
  prependBody: string;
  expiresAt: number | null;
  remainingDeliveries: number | null;
  createdAt: number;
}

export interface CreatedWebhook extends WebhookRecord {
  token: string;
}

export interface TurnRequest {
  readonly threadId: ThreadId;
  readonly deliveryId: DeliveryId;
  readonly message: string;
  readonly mode: DeliveryMode;
  readonly idleTimeout: Duration.DurationInput;
  readonly turnTimeout: Duration.DurationInput;
}

export type TurnOutcome =
  | {
      readonly _tag: "Completed";
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly transport: TransportId;
    }
  | {
      readonly _tag: "Steered";
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly transport: TransportId;
    };
