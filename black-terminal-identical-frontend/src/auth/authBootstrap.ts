export const AUTH_BOOTSTRAP_TIMEOUT_MS = 7_000;

export class AuthBootstrapTimeoutError extends Error {
  constructor() {
    super("Secure session restoration timed out.");
    this.name = "AuthBootstrapTimeoutError";
  }
}

/**
 * Auth recovery must never hold the entire application on a blank bootstrap
 * screen. The underlying client may still settle later, but the UI is released
 * to the sign-in flow once this bounded deadline expires.
 */
export async function withAuthBootstrapTimeout<T>(
  operation: Promise<T>,
  timeoutMs = AUTH_BOOTSTRAP_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new AuthBootstrapTimeoutError()), Math.max(1, timeoutMs));
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
