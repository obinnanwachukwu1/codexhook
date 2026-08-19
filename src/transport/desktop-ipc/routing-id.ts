export const MAX_ROUTING_ID_LENGTH = 128;

export function routingId(value: unknown): string | undefined {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_ROUTING_ID_LENGTH
    ? value
    : undefined;
}
