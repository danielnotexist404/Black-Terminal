export const SECURE_SESSION_UNAVAILABLE_CODE = "SECURE_SESSION_UNAVAILABLE";

type SessionLike = {
  access_token?: string | null;
};

type UserLike = {
  id?: string | null;
};

type AuthResult<T> = {
  data: T;
  error?: unknown;
};

export type AuthSessionClient = {
  getSession: () => Promise<AuthResult<{ session: SessionLike | null }>>;
  refreshSession: () => Promise<AuthResult<{ session: SessionLike | null }>>;
  getUser: (accessToken?: string) => Promise<AuthResult<{ user: UserLike | null }>>;
};

export class SecureSessionUnavailableError extends Error {
  readonly code = SECURE_SESSION_UNAVAILABLE_CODE;

  constructor(message = "Your secure session is unavailable. Sign in again; your editor draft has been preserved for recovery.", options?: ErrorOptions) {
    super(message, options);
    this.name = "SecureSessionUnavailableError";
  }
}

function accessToken(session: SessionLike | null | undefined) {
  return typeof session?.access_token === "string" && session.access_token.trim()
    ? session.access_token
    : null;
}

async function validatedUser(auth: AuthSessionClient, session: SessionLike | null) {
  const token = accessToken(session);
  if (!token) return null;
  const result = await auth.getUser(token);
  if (result.error || !result.data.user?.id) return null;
  return { accessToken: token, user: result.data.user };
}

/**
 * Resolve an identity for owner-scoped storage without trusting the terminal's
 * cached UI profile. A missing/stale access token receives one explicit refresh
 * attempt before the caller is sent through reauthentication.
 */
export async function resolveAuthenticatedSession(auth: AuthSessionClient) {
  let firstFailure: unknown;
  try {
    const current = await auth.getSession();
    firstFailure = current.error;
    const validated = await validatedUser(auth, current.data.session);
    if (validated) return validated;
  } catch (error) {
    firstFailure = error;
  }

  try {
    const refreshed = await auth.refreshSession();
    const validated = await validatedUser(auth, refreshed.data.session);
    if (validated) return validated;
    if (refreshed.error) firstFailure = refreshed.error;
  } catch (error) {
    firstFailure = error;
  }

  throw new SecureSessionUnavailableError(undefined, firstFailure ? { cause: firstFailure } : undefined);
}

export function isSecureSessionUnavailableError(error: unknown): error is SecureSessionUnavailableError {
  return error instanceof SecureSessionUnavailableError
    || Boolean(error && typeof error === "object" && "code" in error && error.code === SECURE_SESSION_UNAVAILABLE_CODE);
}
