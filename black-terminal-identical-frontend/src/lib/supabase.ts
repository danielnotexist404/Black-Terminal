import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

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
  password?: string;

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
const CREDS_DB_KEY = "bt_users_creds";
const AUDIT_LOGS_KEY = "bt_audit_logs";

// Helper: Get all users
export async function dbGetUsers(): Promise<DBUser[]> {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bt_users")
        .select("*");
      if (error) throw error;
      if (data) {
        return data.map((u: any) => ({
          username: u.username,
          displayName: u.display_name || u.displayName || u.username,
          email: u.email,
          role: u.role,
          status: u.status,
          createdAt: u.created_at || u.createdAt || new Date().toISOString(),
          lastLogin: u.last_login || u.lastLogin || new Date().toISOString(),
          allowedIndicators: u.allowed_indicators || u.allowedIndicators || [],
          activeIndicators: u.active_indicators || u.activeIndicators || [],
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
        }));
      }
    } catch (e) {
      console.error("Supabase error dbGetUsers, falling back:", e);
    }
  }

  const stored = localStorage.getItem(USERS_DB_KEY);
  const parsed = stored ? JSON.parse(stored) : [];
  return parsed.map((u: any) => ({
    ...u,
    displayName: u.displayName || u.display_name || u.username,
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
  const cleanUser = username.trim();
  const cleanPass = accessCode.trim();

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bt_users")
        .select("password, role")
        .eq("username", cleanUser)
        .single();
      if (error) {
        return { success: false, error: "Access denied: Invalid credentials" };
      }
      if (data && data.password === cleanPass) {
        return { success: true, role: data.role };
      } else {
        return { success: false, error: "Access denied: Invalid credentials" };
      }
    } catch (e) {
      console.error("Supabase verify failed, falling back:", e);
    }
  }

  // Local fallback
  const storedCreds = localStorage.getItem(CREDS_DB_KEY);
  const creds = storedCreds ? JSON.parse(storedCreds) : {};
  if (creds[cleanUser] && creds[cleanUser] === cleanPass) {
    const users = await dbGetUsers();
    const userObj = users.find(u => u.username === cleanUser);
    return { success: true, role: userObj?.role || "user" };
  }
  return { success: false, error: "Access denied: Invalid credentials" };
}

export async function establishSupabaseAuthSession(
  user: Pick<DBUser, "username" | "email" | "role">,
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
  if (signInMessage.toLowerCase().includes("email not confirmed")) {
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

  const signedUp = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        username: user.username,
        role: user.role
      }
    }
  });

  if (signedUp.error) {
    return {
      success: false,
      error: `Supabase Auth sign-in failed. Create or update the Authentication user for ${email} with the same Black Terminal access code. ${signedIn.error?.message || signedUp.error.message}`
    };
  }

  if (signedUp.data.session) {
    return { success: true };
  }

  return {
    success: false,
    needsEmailConfirmation: true,
    error: `Supabase Auth user for ${email} exists or was created, but no active session was returned. Confirm the email or disable email confirmation for this project, then sign in again.`
  };
}

export async function clearSupabaseAuthSession(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;
  await supabase.auth.signOut();
}

// Helper: Register user
export async function dbRegisterUser(user: DBUser, accessCode: string): Promise<{ success: boolean; error?: string }> {
  let ip = user.ip;
  let countryCode = user.countryCode;
  let countryName = user.countryName;
  if (!ip || !countryCode) {
    const geo = await getGeoIPInfo();
    ip = ip || geo.ip;
    countryCode = countryCode || geo.countryCode;
    countryName = countryName || geo.countryName;
  }

  if (isSupabaseConfigured && supabase) {
    try {
      // Check if user already exists
      const { data: existing } = await supabase
        .from("bt_users")
        .select("username")
        .eq("username", user.username)
        .maybeSingle();
      if (existing) {
        return { success: false, error: "Username already exists" };
      }

      const payload = {
        username: user.username,
        display_name: user.displayName || user.username,
        email: user.email,
        password: accessCode.trim(),
        role: user.role,
        status: user.status,
        created_at: user.createdAt,
        last_login: user.lastLogin,
        allowed_indicators: user.allowedIndicators,
        active_indicators: user.activeIndicators,
        workspaces: user.workspaces || ["Quant Desk", "Scalp Layout", "Strategy Lab"],
        workspace_snapshots: user.workspaceSnapshots || {},
        active_workspace: user.activeWorkspace || "Quant Desk",
        alerts: user.alerts || [],
        scripts: user.scripts || [],
        alert_event_logs: user.alertEventLogs || [],
        ip: ip,
        country_code: countryCode,
        country_name: countryName,
        first_name: user.firstName || "",
        last_name: user.lastName || "",
        organization: user.organization || "",
        billing_address: user.billingAddress || "",
        purpose_of_use: user.purposeOfUse || "personal",
        phone: user.phone || "",
        newsletter_opt_in: user.newsletterOptIn || false,
        referred_by: user.referredBy || "",
        email_verified: user.emailVerified || false
      };

      const { error } = await supabase.from("bt_users").insert(payload);
      if (error) {
        const message = error.message || "";
        if (message.includes("display_name") || error.code === "PGRST204") {
          const compatiblePayload: any = { ...payload };
          delete compatiblePayload.display_name;
          const retry = await supabase.from("bt_users").insert(compatiblePayload);
          if (retry.error) throw retry.error;
        } else {
          throw error;
        }
      }
      return { success: true };
    } catch (e: any) {
      console.error("Supabase register error:", e);
      return { success: false, error: e.message || "Database execution failed" };
    }
  }

  // Local fallback
  const storedCreds = localStorage.getItem(CREDS_DB_KEY);
  const creds = storedCreds ? JSON.parse(storedCreds) : {};
  if (creds[user.username]) {
    return { success: false, error: "Username already exists" };
  }

  const users = await dbGetUsers();
  users.push({
    ...user,
    ip,
    countryCode,
    countryName
  });
  localStorage.setItem(USERS_DB_KEY, JSON.stringify(users));

  creds[user.username] = accessCode.trim();
  localStorage.setItem(CREDS_DB_KEY, JSON.stringify(creds));

  return { success: true };
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
      if (patch.password !== undefined) dbPatch.password = patch.password;
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
  if (patch.password !== undefined) {
    const storedCreds = localStorage.getItem(CREDS_DB_KEY);
    const creds = storedCreds ? JSON.parse(storedCreds) : {};
    creds[username] = patch.password.trim();
    localStorage.setItem(CREDS_DB_KEY, JSON.stringify(creds));
  }
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

  const storedCreds = localStorage.getItem(CREDS_DB_KEY);
  const creds = storedCreds ? JSON.parse(storedCreds) : {};
  delete creds[username];
  localStorage.setItem(CREDS_DB_KEY, JSON.stringify(creds));
}

// Helper: Get audit logs
export async function dbGetAuditLogs(): Promise<DBAuditLog[]> {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bt_audit_logs")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      if (data) {
        return data.map((l: any) => ({
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
  if (isSupabaseConfigured && supabase) {
    try {
      const { error } = await supabase
        .from("bt_audit_logs")
        .insert({
          timestamp,
          tag,
          message,
          created_at: new Date().toISOString()
        });
      if (error) throw error;
      return;
    } catch (e) {
      console.error("Supabase add log failed, falling back:", e);
    }
  }

  const stored = localStorage.getItem(AUDIT_LOGS_KEY);
  const logs = stored ? JSON.parse(stored) : [];
  const logMsg = { timestamp, tag, message };
  localStorage.setItem(AUDIT_LOGS_KEY, JSON.stringify([logMsg, ...logs]));
}
