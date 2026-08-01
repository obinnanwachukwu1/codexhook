const UNITS = {
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
} as const;

export function parseExpiration(
  value: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): number | null {
  if (value === "never") return null;
  const match = /^([1-9]\d*)(m|h|d|w)$/.exec(value);
  if (match == null) {
    throw new Error("expiration must be a positive duration such as 1h, 7d, or never");
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNITS;
  const seconds = amount * UNITS[unit];
  if (!Number.isSafeInteger(seconds)) throw new Error("expiration is too large");
  return nowSeconds + seconds;
}

export function parseDeliveryLimit(value: string): number | null {
  if (value === "unlimited") return null;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("max deliveries must be a positive integer or unlimited");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("max deliveries is too large");
  return parsed;
}
