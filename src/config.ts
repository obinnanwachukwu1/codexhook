import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 9465;
export const DEFAULT_PREPEND_BODY = "Webhook {hookId}:\n\n";
export const DEFAULT_EXPIRES_IN = "24h";
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_PREPEND_BYTES = 4 * 1024;

export function dataDirectory(environment = process.env): string {
  return path.resolve(
    environment.CODEXHOOK_HOME ?? path.join(homedir(), ".codexhook"),
  );
}

export function ensureDataDirectory(directory = dataDirectory()): string {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  return directory;
}

export function databasePath(directory = dataDirectory()): string {
  return path.join(directory, "codexhook.sqlite");
}

export function defaultBaseUrl(
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
): string {
  return `http://${host}:${port}`;
}

export function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("base URL must use http or https");
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function webhookUrl(baseUrl: string, token: string): string {
  return new URL(`w/${token}`, normalizeBaseUrl(baseUrl)).toString();
}
