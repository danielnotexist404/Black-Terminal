import { createClient } from "@supabase/supabase-js";
import type { ProductTier, TerminalCapability } from "../core/permissions/capabilities";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

const GOOGLE_OAUTH_INTENT_KEY = "bt_google_oauth_intent";

export interface DBUser {
  username: string;
  displayName?: string;
  email: string;
  role: "admin" | "user";
  status: "online" | "offline" | "suspended";
  createdAt: string;
  lastLogin: string;
  allowedIndicators: string[];
  activeIndicators: string[];
  productTier?: ProductTier;
  permissions?: TerminalCapability[];

  // Configuration persistence fields
  workspaces?: string[];
  workspaceSnapshots?: any;
  activeWorkspace?: string;
  alerts?: any[];
  scripts?: any[];
  alertEventLogs?: any[];
  ip?: string;
  countryCode?: string;
  countryName?: string;
  firstName?: string;
  lastName?: string;
  organization?: string;
  billingAddress?: string;
  purposeOfUse?: "personal" | "commercial";
  phone?: string;
  newsletterOptIn?: boolean;
  referredBy?: string;
  emailVerified?: boolean;
  aiMessagesCount?: number;
  aiLastMessageTimestamp?: string;
}

export interface DBAuditLog {
  timestamp: string;
  tag: "CREATE" | "LOGIN" | "LOGOUT" | "SUSPEND" | "REACTIVATE" | "DELETE" | "ERROR" | "STATUS" | "INDICATOR" | "SYSTEM" | "WEBHOOK";
  message: string;
}

// Local mock keys
const USERS_DB_KEY = "bt_users_db";
const AUDIT_LOGS_KEY = "bt_audit_logs";

function normalizeProductTier(value: unknown, role?: "admin" | "user"): ProductTier {
  if (role === "admin") return "admin";
  if (value === "professional" || value === "enterprise" || value === "admin") return value;
  return "retail";
}

function normalizePermissions(value: unknown): TerminalCapability[] {
  return Array.isArray(value) ? value.filter((item): item is TerminalCapability => typeof item === "string") : [];
}

function mapDatabaseUser(u: any): DBUser {
  return {
    username: u.username,
    displayName: u.display_name || u.displayName || u.username,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.created_at || u.createdAt || new Date().toISOString(),
    lastLogin: u.last_login || u.lastLogin || new Date().toISOString(),
    allowedIndicators: u.allowed_indicators || u.allowedIndicators || [],
    activeIndicators: u.active_indicators || u.activeIndicators || [],
    productTier: normalizeProductTier(u.product_tier || u.productTier, u.role),
    permissions: normalizePermissions(u.permissions),
    workspaces: u.workspaces || [],
    workspaceSnapshots: u.workspace_snapshots || {},
    activeWorkspace: u.active_workspace || "Quant Desk",
    alerts: u.alerts || [],
    scripts: u.scripts || [],
    alertEventLogs: u.alert_event_logs || [],
    ip: u.ip || "127.0.0.1",
    countryCode: u.country_code || u.countryCode || "IL",
    countryName: u.country_name || u.countryName || "Israel",
    firstName: u.first_name || u.firstName || "",
    lastName: u.last_name || u.lastName || "",
    organization: u.organization || "",
    billingAddress: u.billing_address || u.billingAddress || "",
    purposeOfUse: u.purpose_of_use || u.purposeOfUse || "personal",
    phone: u.phone || "",
    newsletterOptIn: u.newsletter_opt_in ?? u.newsletterOptIn ?? false,
    referredBy: u.referred_by || u.referredBy || "",
    emailVerified: u.email_verified ?? u.emailVerified ?? false,
    aiMessagesCount: u.ai_messages_count ?? u.aiMessagesCount ?? 0,
    aiLastMessageTimestamp: u.ai_last_message_timestamp || u.aiLastMessageTimestamp || ""
  };
}

export function hasGoogleOAuthIntent(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("auth") === "google" || window.sessionStorage.getItem(GOOGLE_OAUTH_INTENT_KEY) === "google";
}

export function getGoogleOAuthError(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("error_description") || params.get("error") || null;
}

export function clearGoogleOAuthIntent(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(GOOGLE_OAUTH_INTENT_KEY);
  const url = new URL(window.location.href);
  ["auth", "error", "error_code", "error_description"].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export async function signInWithGoogle(): Promise<{ success: boolean; error?: string }> {
  if (!isSupabaseConfigured || !supabase) {
    return { success: false, error: "Google SSO is unavailable because Supabase Auth is not configured." };
  }
  if (typeof window === "undefined") return { success: false, error: "Google SSO requires a browser session." };

  const redirectUrl = new URL("/", window.location.origin);
  redirectUrl.searchParams.set("auth", "google");
  window.sessionStorage.setItem(GOOGLE_OAUTH_INTENT_KEY, "google");

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: redirectUrl.toString() }
  });
  if (error) {
    window.sessionStorage.removeItem(GOOGLE_OAUTH_INTENT_KEY);
    return { success: false, error: error.message };
  }
  return { success: true };
}

export async function dbGetCurrentUserProfile(options: { retries?: number } = {}): Promise<DBUser | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) return null;

  const retries = Math.max(0, Math.min(options.retries ?? 4, 8));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { data, error } = await supabase
      .from("bt_users")
      .select("*")
      .eq("auth_user_id", authData.user.id)
      .maybeSingle();
    if (error) throw error;
    if (data) return mapDatabaseUser(data);
    if (attempt < retries) await new Promise((resolve) => window.setTimeout(resolve, 180 * (attempt + 1)));
  }
  return null;
}

export type CurrentUserProfilePatch = Pick<DBUser,
  "displayName" | "firstName" | "lastName" | "organization" | "billingAddress" |
  "purposeOfUse" | "phone" | "newsletterOptIn" | "referredBy"
>;

export async function dbUpdateCurrentUserProfile(patch: Partial<CurrentUserProfilePatch>): Promise<DBUser> {
  if (!isSupabaseConfigured || !supabase) throw new Error("Secure profile storage is unavailable.");
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error("Sign in again to update your profile.");

  const dbPatch: Record<string, unknown> = {};
  if (patch.displayName !== undefined) dbPatch.display_name = patch.displayName;
  if (patch.firstName !== undefined) dbPatch.first_name = patch.firstName;
  if (patch.lastName !== undefined) dbPatch.last_name = patch.lastName;
  if (patch.organization !== undefined) dbPatch.organization = patch.organization;
  if (patch.billingAddress !== undefined) dbPatch.billing_address = patch.billingAddress;
  if (patch.purposeOfUse !== undefined) dbPatch.purpose_of_use = patch.purposeOfUse;
  if (patch.phone !== undefined) dbPatch.phone = patch.phone;
  if (patch.newsletterOptIn !== undefined) dbPatch.newsletter_opt_in = patch.newsletterOptIn;
  if (patch.referredBy !== undefined) dbPatch.referred_by = patch.referredBy;
  if (Object.keys(dbPatch).length === 0) {
    const existing = await dbGetCurrentUserProfile();
    if (!existing) throw new Error("Secure user profile was not found.");
    return existing;
  }

  const { data, error } = await supabase
    .from("bt_users")
    .update(dbPatch)
    .eq("auth_user_id", authData.user.id)
    .select("*")
    .single();
  if (error) throw error;
  return mapDatabaseUser(data);
}

// Helper: Get all users
export async function dbGetUsers(options: { allowLocalFallback?: boolean } = {}): Promise<DBUser[]> {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bt_users")
        .select("*");
      if (error) throw error;
      if (data) {
        return data.map(mapDatabaseUser);
      }
    } catch (e) {
      console.error("Supabase error dbGetUsers, falling back:", e);
      if (options.allowLocalFallback === false) throw e;
    }
  }

  const stored = localStorage.getItem(USERS_DB_KEY);
  const parsed = stored ? JSON.parse(stored) : [];
  return parsed.map((u: any) => ({
    ...u,
    displayName: u.displayName || u.display_name || u.username,
    productTier: normalizeProductTier(u.productTier || u.product_tier, u.role),
    permissions: normalizePermissions(u.permissions),
    ip: u.ip || "127.0.0.1",
    countryCode: u.countryCode || u.country_code || "IL",
    countryName: u.countryName || u.country_name || "Israel",
    firstName: u.firstName || u.first_name || "",
    lastName: u.lastName || u.last_name || "",
    organization: u.organization || "",
    billingAddress: u.billingAddress || u.billing_address || "",
    purposeOfUse: u.purposeOfUse || u.purpose_of_use || "personal",
    phone: u.phone || "",
    newsletterOptIn: u.newsletterOptIn ?? u.newsletter_opt_in ?? false,
    referredBy: u.referredBy || u.referred_by || "",
    emailVerified: u.emailVerified ?? u.email_verified ?? false,
    aiMessagesCount: u.aiMessagesCount ?? u.ai_messages_count ?? 0,
    aiLastMessageTimestamp: u.aiLastMessageTimestamp || u.ai_last_message_timestamp || ""
  }));
}

export async function getGeoIPInfo(): Promise<{ ip: string; countryCode: string; countryName: string }> {
  let ip = "127.0.0.1";
  let countryCode = "IL";
  let countryName = "Israel";
  try {
    const res = await fetch("https://ipapi.co/json/");
    if (res.ok) {
      const geo = await res.json();
      if (geo.ip) ip = geo.ip;
      if (geo.country_code) countryCode = geo.country_code;
      if (geo.country_name) countryName = geo.country_name;
    }
  } catch (e) {
    console.error("Geo IP lookup failed:", e);
  }
  return { ip, countryCode, countryName };
}

// Helper: Verify credentials and return user role
export async function dbVerifyUser(username: string, accessCode: string): Promise<{ success: boolean; role?: "admin" | "user"; error?: string }> {
  const email = username.trim().toLowerCase();
  const password = accessCode.trim();
  if (!isSupabaseConfigured || !supabase) return { success: false, error: "Secure authentication is unavailable." };
  if (!email.includes("@")) return { success: false, error: "Enter your verified email address, not a legacy username." };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { success: false, error: "Access denied: Invalid credentials or unverified email." };
  const profile = await dbGetCurrentUserProfile({ retries: 2 });
  if (!profile) return { success: false, error: "Secure account profile is unavailable." };
  return { success: true, role: profile.role };
}

export async function dbAdminGetUsers(): Promise<DBUser[]> {
  const payload = await authenticatedApiRequest<{ users: DBUser[] }>("/api/security/admin-users", { method: "GET" });
  return payload.users || [];
}

export async function dbAdminCreateUser(username: string, email: string, password: string): Promise<void> {
  await authenticatedApiRequest("/api/security/admin-users", {
    method: "POST",
    body: JSON.stringify({ action: "create", username, email, password })
  });
}

export async function dbAdminUpdateUser(username: string, patch: Partial<DBUser>): Promise<void> {
  const allowed = {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.allowedIndicators !== undefined ? { allowedIndicators: patch.allowedIndicators } : {}),
    ...(patch.productTier !== undefined ? { productTier: patch.productTier } : {}),
    ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
    ...(patch.aiMessagesCount !== undefined ? { aiMessagesCount: patch.aiMessagesCount } : {})
  };
  await authenticatedApiRequest("/api/security/admin-users", {
    method: "POST",
    body: JSON.stringify({ action: "update", username, patch: allowed })
  });
}

export async function dbAdminDeleteUser(username: string): Promise<void> {
  await authenticatedApiRequest("/api/security/admin-users", {
    method: "POST",
    body: JSON.stringify({ action: "delete", username })
  });
}

export async function establishSupabaseAuthSession(
  user: Pick<DBUser, "username" | "displayName" | "email" | "role">,
  accessCode: string,
  options: { allowCreate?: boolean } = {}
): Promise<{ success: boolean; error?: string; needsEmailConfirmation?: boolean }> {
  if (!isSupabaseConfigured || !supabase) return { success: true };

  const email = user.email?.trim();
  const password = accessCode.trim();
  if (!email || !password) {
    return { success: false, error: "Supabase Auth requires the user's email and access code." };
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await supabase.auth.getSession();
  const existingEmail = existing.data.session?.user?.email?.toLowerCase();
  if (existing.data.session && existingEmail === normalizedEmail) {
    return { success: true };
  }

  if (existing.data.session) {
    await supabase.auth.signOut();
  }

  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (!signedIn.error && signedIn.data.session) {
    return { success: true };
  }

  const signInMessage = signedIn.error?.message || "Unknown Supabase Auth error.";
  if (!options.allowCreate && signInMessage.toLowerCase().includes("email not confirmed")) {
    return {
      success: false,
      needsEmailConfirmation: true,
      error: `Supabase Auth email is not confirmed for ${email}. Manually confirm this user in Supabase Authentication, then sign in again.`
    };
  }

  if (!options.allowCreate) {
    return {
      success: false,
      error: `Supabase Auth sign-in failed for ${email}. Create or update this Authentication user with the same Black Terminal access code. ${signInMessage}`
    };
  }

  const signup = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username: user.username, display_name: user.displayName || user.username } }
  });
  if (signup.error) return { success: false, error: signup.error.message };
  if (!signup.data.session) {
    return { success: false, needsEmailConfirmation: true, error: "Check your email and confirm the Supabase Auth registration, then sign in." };
  }
  return { success: true };
}

export async function clearSupabaseAuthSession(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;
  await supabase.auth.signOut();
}

// Helper: Register user
export async function dbRegisterUser(user: DBUser, _accessCode: string): Promise<{ success: boolean; error?: string }> {
  if (isSupabaseConfigured && supabase) {
    try {
      const payload = {
        display_name: user.displayName || user.username,
        last_login: user.lastLogin,
        active_indicators: user.activeIndicators,
        workspaces: user.workspaces || ["Quant Desk", "Scalp Layout", "Strategy Lab"],
        workspace_snapshots: user.workspaceSnapshots || {},
        active_workspace: user.activeWorkspace || "Quant Desk",
        alerts: user.alerts || [],
        scripts: user.scripts || [],
        alert_event_logs: user.alertEventLogs || [],
        first_name: user.firstName || "",
        last_name: user.lastName || "",
        organization: user.organization || "",
        billing_address: user.billingAddress || "",
        purpose_of_use: user.purposeOfUse || "personal",
        phone: user.phone || "",
        newsletter_opt_in: user.newsletterOptIn || false,
        referred_by: user.referredBy || ""
      };
      const authUserId = (await supabase.auth.getUser()).data.user?.id;
      if (!authUserId) throw new Error("Secure registration session is unavailable.");
      const { data: updated, error } = await supabase.from("bt_users").update(payload).eq("auth_user_id", authUserId).select("username").maybeSingle();
      if (error) throw error;
      if (!updated) throw new Error("Secure user profile was not created.");
      return { success: true };
    } catch (e: any) {
      console.error("Supabase register error:", e);
      return { success: false, error: e.message || "Database execution failed" };
    }
  }

  return { success: false, error: "Secure registration requires Supabase Auth." };
}

// Helper: Update user fields
export async function dbUpdateUser(username: string, patch: Partial<DBUser> & { password?: string }): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    try {
      const dbPatch: any = {};
      if (patch.email !== undefined) dbPatch.email = patch.email;
      if (patch.displayName !== undefined) dbPatch.display_name = patch.displayName;
      if (patch.role !== undefined) dbPatch.role = patch.role;
      if (patch.status !== undefined) dbPatch.status = patch.status;
      if (patch.lastLogin !== undefined) dbPatch.last_login = patch.lastLogin;
      if (patch.allowedIndicators !== undefined) dbPatch.allowed_indicators = patch.allowedIndicators;
      if (patch.activeIndicators !== undefined) dbPatch.active_indicators = patch.activeIndicators;
      if (patch.productTier !== undefined) dbPatch.product_tier = patch.productTier;
      if (patch.permissions !== undefined) dbPatch.permissions = patch.permissions;
      if (patch.password !== undefined) {
        const passwordResult = await supabase.auth.updateUser({ password: patch.password });
        if (passwordResult.error) throw passwordResult.error;
      }
      if (patch.workspaces !== undefined) dbPatch.workspaces = patch.workspaces;
      if (patch.workspaceSnapshots !== undefined) dbPatch.workspace_snapshots = patch.workspaceSnapshots;
      if (patch.activeWorkspace !== undefined) dbPatch.active_workspace = patch.activeWorkspace;
      if (patch.alerts !== undefined) dbPatch.alerts = patch.alerts;
      if (patch.scripts !== undefined) dbPatch.scripts = patch.scripts;
      if (patch.alertEventLogs !== undefined) dbPatch.alert_event_logs = patch.alertEventLogs;
      if (patch.ip !== undefined) dbPatch.ip = patch.ip;
      if (patch.countryCode !== undefined) dbPatch.country_code = patch.countryCode;
      if (patch.countryName !== undefined) dbPatch.country_name = patch.countryName;
      if (patch.firstName !== undefined) dbPatch.first_name = patch.firstName;
      if (patch.lastName !== undefined) dbPatch.last_name = patch.lastName;
      if (patch.organization !== undefined) dbPatch.organization = patch.organization;
      if (patch.billingAddress !== undefined) dbPatch.billing_address = patch.billingAddress;
      if (patch.purposeOfUse !== undefined) dbPatch.purpose_of_use = patch.purposeOfUse;
      if (patch.phone !== undefined) dbPatch.phone = patch.phone;
      if (patch.newsletterOptIn !== undefined) dbPatch.newsletter_opt_in = patch.newsletterOptIn;
      if (patch.referredBy !== undefined) dbPatch.referred_by = patch.referredBy;
      if (patch.emailVerified !== undefined) dbPatch.email_verified = patch.emailVerified;
      if (patch.aiMessagesCount !== undefined) dbPatch.ai_messages_count = patch.aiMessagesCount;
      if (patch.aiLastMessageTimestamp !== undefined) dbPatch.ai_last_message_timestamp = patch.aiLastMessageTimestamp;

      const { error } = await supabase
        .from("bt_users")
        .update(dbPatch)
        .eq("username", username);
      if (error) throw error;
      return;
    } catch (e) {
      console.error("Supabase update user failed, falling back:", e);
    }
  }

  // Local fallback
  const users = await dbGetUsers();
  const index = users.findIndex(u => u.username === username);
  if (index !== -1) {
    users[index] = { ...users[index], ...patch };
    localStorage.setItem(USERS_DB_KEY, JSON.stringify(users));
  }
}

/**
 * Read the signed-in user's custom scripts from the authoritative account row.
 * This deliberately avoids the administrative user-list path so script source
 * never depends on another user's username or a browser-global cache.
 */
export async function dbGetCurrentUserScripts(): Promise<any[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error("Authenticated script storage session is unavailable.");

  const { data, error } = await supabase
    .from("bt_users")
    .select("scripts")
    .eq("auth_user_id", authData.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Authenticated script storage profile is unavailable.");
  return Array.isArray(data.scripts) ? data.scripts : [];
}

/** Persist custom scripts only to the signed-in user's VPS-hosted account row. */
export async function dbSaveCurrentUserScripts(scripts: any[]): Promise<void> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("VPS-backed script storage is unavailable.");
  }
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error("Authenticated script storage session is unavailable.");

  const { data, error } = await supabase
    .from("bt_users")
    .update({ scripts })
    .eq("auth_user_id", authData.user.id)
    .select("auth_user_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Custom scripts were not persisted to the authenticated account.");
}

export type PublicScriptAsset = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  visibility: "public";
  metadata: Record<string, unknown>;
  updated_at: string;
  version?: string;
  market?: string | null;
  timeframe?: string | null;
  risk_profile?: string;
};

/**
 * Community discovery is sourced only from explicitly public publication
 * tables. The private bt_users.scripts JSONB collection is never queried.
 */
export async function dbListPublicScriptAssets(): Promise<{
  indicators: PublicScriptAsset[];
  strategies: PublicScriptAsset[];
}> {
  if (!isSupabaseConfigured || !supabase) return { indicators: [], strategies: [] };
  const [indicatorResult, strategyResult] = await Promise.all([
    supabase
      .from("published_indicators")
      .select("id,user_id,name,description,version,visibility,metadata,updated_at")
      .eq("visibility", "public")
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase
      .from("published_strategies")
      .select("id,user_id,name,description,market,timeframe,risk_profile,visibility,metadata,updated_at")
      .eq("visibility", "public")
      .order("updated_at", { ascending: false })
      .limit(100)
  ]);
  if (indicatorResult.error) throw indicatorResult.error;
  if (strategyResult.error) throw strategyResult.error;
  return {
    indicators: (indicatorResult.data || []) as PublicScriptAsset[],
    strategies: (strategyResult.data || []) as PublicScriptAsset[]
  };
}

// Helper: Delete user
export async function dbDeleteUser(username: string): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    try {
      const { error } = await supabase
        .from("bt_users")
        .delete()
        .eq("username", username);
      if (error) throw error;
      return;
    } catch (e) {
      console.error("Supabase delete user failed, falling back:", e);
    }
  }

  // Local fallback
  const users = await dbGetUsers();
  const updated = users.filter(u => u.username !== username);
  localStorage.setItem(USERS_DB_KEY, JSON.stringify(updated));

}

// Helper: Get audit logs
export async function dbGetAuditLogs(): Promise<DBAuditLog[]> {
  if (isSupabaseConfigured && supabase) {
    try {
      const result = await authenticatedApiRequest<{ logs: any[] }>("/api/security/audit", { method: "GET" });
      if (result.logs) {
        return result.logs.map((l: any) => ({
          timestamp: l.timestamp,
          tag: l.tag,
          message: l.message
        }));
      }
    } catch (e) {
      console.error("Supabase get logs failed, falling back:", e);
    }
  }

  const stored = localStorage.getItem(AUDIT_LOGS_KEY);
  return stored ? JSON.parse(stored) : [];
}

// Helper: Add audit log
export async function dbAddAuditLog(tag: DBAuditLog["tag"], message: string): Promise<void> {
  const timestamp = new Date().toLocaleTimeString();
  const safeMessage = `${tag} event recorded by Black Terminal.`;
  if (isSupabaseConfigured && supabase) {
    try {
      await authenticatedApiRequest("/api/security/audit", { method: "POST", body: JSON.stringify({ tag }) });
      return;
    } catch (e) {
      console.error("Supabase add log failed, falling back:", e);
    }
  }

  const stored = localStorage.getItem(AUDIT_LOGS_KEY);
  const logs = stored ? JSON.parse(stored) : [];
  void message;
  const logMsg = { timestamp, tag, message: safeMessage };
  localStorage.setItem(AUDIT_LOGS_KEY, JSON.stringify([logMsg, ...logs]));
}

async function authenticatedApiRequest<T = { success: boolean }>(url: string, init: RequestInit): Promise<T> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to continue.");
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Secure API request failed.");
  return payload as T;
}
