function sameOriginEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Keep browser authentication and PostgREST calls behind Black Terminal's
 * production gateway. This is required by the terminal CSP and avoids moving
 * persisted auth state between preview and production API hostnames.
 */
export function resolveSupabaseEndpoint(
  configuredUrl: string,
  useSameOrigin: unknown,
  browserOrigin?: string
): string {
  const configured = configuredUrl.trim().replace(/\/$/, "");
  if (!sameOriginEnabled(useSameOrigin) || !browserOrigin) return configured;

  try {
    const origin = new URL(browserOrigin).origin;
    return origin === "null" ? configured : origin;
  } catch {
    return configured;
  }
}

/**
 * Accept an implicit callback created by the previously deployed client once,
 * then default every new OAuth attempt to PKCE. URL fragments never leave the
 * browser and are removed by Supabase after successful recovery.
 */
export function resolveSupabaseFlowType(locationHash?: string): "implicit" | "pkce" {
  const fragment = new URLSearchParams((locationHash || "").replace(/^#/, ""));
  return fragment.has("access_token") && fragment.has("refresh_token") ? "implicit" : "pkce";
}
