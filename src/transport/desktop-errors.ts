export class DesktopTimeoutError extends Error {
  override readonly name = "DesktopTimeoutError";
}

export function desktopErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function withDesktopTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new DesktopTimeoutError(message)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timeout);
        reject(cause);
      },
    );
  });
}
