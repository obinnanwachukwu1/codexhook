import { lstat } from "node:fs/promises";

export async function desktopEndpointIdentity(
  socketPath: string,
): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const info = await lstat(socketPath);
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}
