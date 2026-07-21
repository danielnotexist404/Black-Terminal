import { z } from "zod";
import { sendError } from "../../portfolio-api.js";
import { getClientIp } from "../http-security.js";
import { requireApiSecurity, writeSecurityAudit } from "../securityMiddleware.js";

const createSchema = z.object({
  action: z.literal("create"),
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email().max(254),
  password: z.string().min(12).max(128)
}).strict();

const updateSchema = z.object({
  action: z.literal("update"),
  username: z.string().trim().min(3).max(64),
  patch: z.object({
    status: z.enum(["online", "offline", "suspended"]).optional(),
    allowedIndicators: z.array(z.string().max(80)).max(64).optional(),
    productTier: z.enum(["retail", "professional", "enterprise"]).optional(),
    permissions: z.array(z.string().max(100)).max(64).optional(),
    aiMessagesCount: z.number().int().min(0).max(1000000).optional()
  }).strict().refine((value) => Object.keys(value).length > 0, "No changes supplied")
}).strict();

const deleteSchema = z.object({
  action: z.literal("delete"),
  username: z.string().trim().min(3).max(64)
}).strict();

const requestSchema = z.discriminatedUnion("action", [createSchema, updateSchema, deleteSchema]);

export async function handleAdminUsers(req, res) {
  try {
    if (!["GET", "POST", "OPTIONS"].includes(req.method)) return res.status(405).json({ error: "Method Not Allowed" });
    const security = await requireApiSecurity(req, res, {
      endpoint: "admin.users",
      maxBytes: 32 * 1024,
      rateLimit: { perMinute: 30, perDay: 2000 }
    });
    if (security.handled) return;
    if (security.identity.role !== "admin") throw forbidden();

    if (req.method === "GET") {
      const { data, error } = await security.supabase.from("bt_users").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json({ users: (data || []).map(toClientUser) });
    }

    const input = requestSchema.parse(req.body);
    if (input.action === "create") await createUser(security.supabase, input);
    if (input.action === "update") await updateUser(security.supabase, input);
    if (input.action === "delete") await deleteUser(security.supabase, input, security.user.id);
    await writeSecurityAudit(security.supabase, {
      userId: security.user.id,
      type: `ADMIN_USER_${input.action.toUpperCase()}`,
      severity: input.action === "delete" ? "WARNING" : "INFO",
      endpoint: "admin.users",
      ip: getClientIp(req),
      metadata: { targetUsername: input.username }
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error?.name === "ZodError") return res.status(400).json({ error: "Invalid admin request.", code: "INVALID_REQUEST" });
    return sendError(res, error);
  }
}

async function createUser(supabase, input) {
  const created = await supabase.auth.admin.createUser({
    email: input.email.toLowerCase(),
    password: input.password,
    email_confirm: true,
    user_metadata: { username: input.username, display_name: input.username }
  });
  if (created.error || !created.data.user) throw publicError(409, "Unable to create this user.", "USER_CREATE_FAILED");
  const { error } = await supabase.from("bt_users").upsert({
    username: input.username,
    email: input.email.toLowerCase(),
    auth_user_id: created.data.user.id,
    role: "user",
    status: "offline",
    product_tier: "retail",
    permissions: [],
    email_verified: true
  }, { onConflict: "username" });
  if (error) {
    await supabase.auth.admin.deleteUser(created.data.user.id);
    throw error;
  }
}

async function updateUser(supabase, input) {
  const columnMap = {
    status: "status",
    allowedIndicators: "allowed_indicators",
    productTier: "product_tier",
    permissions: "permissions",
    aiMessagesCount: "ai_messages_count"
  };
  const payload = Object.fromEntries(Object.entries(input.patch).map(([key, value]) => [columnMap[key], value]));
  const { data, error } = await supabase.from("bt_users").update(payload).eq("username", input.username).select("username").maybeSingle();
  if (error) throw error;
  if (!data) throw publicError(404, "User not found.", "USER_NOT_FOUND");
}

async function deleteUser(supabase, input, actorId) {
  const { data, error } = await supabase.from("bt_users").select("auth_user_id,role").eq("username", input.username).maybeSingle();
  if (error) throw error;
  if (!data) throw publicError(404, "User not found.", "USER_NOT_FOUND");
  if (data.auth_user_id === actorId || data.role === "admin") throw publicError(403, "Administrator accounts cannot be deleted here.", "ADMIN_DELETE_BLOCKED");
  if (data.auth_user_id) {
    const deleted = await supabase.auth.admin.deleteUser(data.auth_user_id);
    if (deleted.error) throw deleted.error;
  } else {
    const removed = await supabase.from("bt_users").delete().eq("username", input.username);
    if (removed.error) throw removed.error;
  }
}

function toClientUser(row) {
  return {
    username: row.username,
    displayName: row.display_name || row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLogin: row.last_login,
    allowedIndicators: row.allowed_indicators || [],
    activeIndicators: row.active_indicators || [],
    productTier: row.role === "admin" ? "admin" : row.product_tier || "retail",
    permissions: row.permissions || [],
    ip: row.ip,
    countryCode: row.country_code,
    countryName: row.country_name,
    firstName: row.first_name,
    lastName: row.last_name,
    organization: row.organization,
    billingAddress: row.billing_address,
    purposeOfUse: row.purpose_of_use,
    phone: row.phone,
    newsletterOptIn: row.newsletter_opt_in,
    referredBy: row.referred_by,
    emailVerified: row.email_verified,
    aiMessagesCount: row.ai_messages_count,
    aiLastMessageTimestamp: row.ai_last_message_timestamp
  };
}

function forbidden() {
  return publicError(403, "Administrator access required.", "ADMIN_REQUIRED");
}

function publicError(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, code });
}
