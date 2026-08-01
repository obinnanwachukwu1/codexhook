import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { DEFAULT_HOST, DEFAULT_PORT } from "./config.js";

const FIRST_DYNAMIC_PORT = 49_152;
const LAST_PORT = 65_535;
const MAX_RANDOM_ATTEMPTS = 64;

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > LAST_PORT) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return port;
}

export function portIsAvailable(
  port: number,
  host = DEFAULT_HOST,
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    server.unref();
    server.once("error", () => finish(false));
    server.listen(port, host, () => {
      server.close(() => finish(true));
    });
  });
}

export interface ChoosePortOptions {
  requested?: number | undefined;
  previous?: number | undefined;
  isAvailable?: ((port: number) => Promise<boolean>) | undefined;
  randomPort?: (() => number) | undefined;
}

export async function chooseInstallationPort(
  options: ChoosePortOptions = {},
): Promise<number> {
  const isAvailable = options.isAvailable ?? portIsAvailable;
  if (options.requested != null) {
    if (options.requested === options.previous) return options.requested;
    if (!(await isAvailable(options.requested))) {
      throw new Error(`port ${options.requested} is already in use`);
    }
    return options.requested;
  }
  if (options.previous != null) return options.previous;
  if (await isAvailable(DEFAULT_PORT)) return DEFAULT_PORT;

  const nextRandom =
    options.randomPort ??
    (() => randomInt(FIRST_DYNAMIC_PORT, LAST_PORT + 1));
  for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
    const candidate = nextRandom();
    if (candidate < FIRST_DYNAMIC_PORT || candidate > LAST_PORT) {
      throw new Error("random port must be between 49152 and 65535");
    }
    if (await isAvailable(candidate)) return candidate;
  }
  throw new Error("could not find an available local port");
}
