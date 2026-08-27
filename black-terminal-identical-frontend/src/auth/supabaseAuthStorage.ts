export const BLACK_TERMINAL_AUTH_STORAGE_KEY = "bt-supabase-auth-v1";

type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type StoredSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
};

function defaultSupabaseStorageKey(url: string): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.split(".")[0]?.trim();
    return hostname ? `sb-${hostname}-auth-token` : null;
  } catch {
    return null;
  }
}

function decodeStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession> | null;
    if (!value || typeof value.access_token !== "string" || typeof value.refresh_token !== "string") return null;
    if (!value.access_token || !value.refresh_token) return null;
    return {
      access_token: value.access_token,
      refresh_token: value.refresh_token,
      expires_at: Number.isFinite(value.expires_at) ? Number(value.expires_at) : undefined
    };
  } catch {
    return null;
  }
}

export function legacySupabaseAuthStorageKeys(configuredUrl: string, resolvedUrl: string): string[] {
  return [...new Set([
    defaultSupabaseStorageKey(configuredUrl),
    defaultSupabaseStorageKey(resolvedUrl)
  ].filter((value): value is string => Boolean(value) && value !== BLACK_TERMINAL_AUTH_STORAGE_KEY))];
}

/**
 * Supabase derives its default browser key from the API hostname. Moving the
 * API behind Black Terminal's same-origin gateway therefore made an otherwise
 * valid session invisible to a newly-created client. Move the newest known
 * session into an application-owned stable key before the client starts.
 *
 * Only exact keys derived from this deployment's configured/resolved endpoints
 * are considered. Tokens are never logged or copied outside browser storage.
 */
export function migrateSupabaseAuthStorage(
  storage: AuthStorage,
  configuredUrl: string,
  resolvedUrl: string
): { migrated: boolean; sourceKey?: string } {
  const legacyKeys = legacySupabaseAuthStorageKeys(configuredUrl, resolvedUrl);
  const stableRaw = storage.getItem(BLACK_TERMINAL_AUTH_STORAGE_KEY);
  if (decodeStoredSession(stableRaw)) {
    legacyKeys.forEach((key) => storage.removeItem(key));
    return { migrated: false };
  }

  const candidates = legacyKeys.flatMap((key) => {
    const raw = storage.getItem(key);
    const session = decodeStoredSession(raw);
    return raw && session ? [{ key, raw, expiresAt: session.expires_at ?? 0 }] : [];
  }).sort((left, right) => right.expiresAt - left.expiresAt);

  const selected = candidates[0];
  if (!selected) return { migrated: false };

  storage.setItem(BLACK_TERMINAL_AUTH_STORAGE_KEY, selected.raw);
  legacyKeys.forEach((key) => storage.removeItem(key));
  return { migrated: true, sourceKey: selected.key };
}

export function prepareSupabaseAuthStorage(configuredUrl: string, resolvedUrl: string): void {
  if (typeof window === "undefined") return;
  try {
    migrateSupabaseAuthStorage(window.localStorage, configuredUrl, resolvedUrl);
  } catch {
    // Browsers can deny storage access in hardened/private contexts. Supabase
    // will report the missing session through the normal authenticated path.
  }
}
