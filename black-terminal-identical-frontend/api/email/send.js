import { z } from "zod";
import { ALLOWED_EMAIL_TEMPLATES, renderEmailTemplate } from "../../server/security/email-templates.js";
import { getClientIp } from "../../server/security/http-security.js";
import { requireApiSecurity, writeSecurityAudit } from "../../server/security/securityMiddleware.js";
import { sendError } from "../../server/portfolio-api.js";

const requestSchema = z.object({
  type: z.enum(ALLOWED_EMAIL_TEMPLATES),
  targetUserId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  data: z.record(z.union([z.string().max(160), z.number(), z.boolean()])).optional()
}).strict();

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "OPTIONS") return res.status(405).json({ error: "Method Not Allowed" });
    const security = await requireApiSecurity(req, res, {
      endpoint: "email.send",
      maxBytes: 50 * 1024,
      rateLimit: { perMinute: 5, perDay: 50 }
    });
    if (security.handled) return;
    const input = requestSchema.parse(req.body);
    const recipient = await resolveRecipient(security.supabase, security.user, input);
    const template = renderEmailTemplate(input.type, input.data);
    const apiKey = process.env.RESEND_API_KEY || process.env.VITE_RESEND_API_KEY;
    const from = process.env.RESEND_FROM || process.env.VITE_RESEND_FROM || "Black Terminal <alerts@black-terminal.live>";
    if (!apiKey) throw Object.assign(new Error("Email provider is unavailable."), { statusCode: 503, code: "EMAIL_PROVIDER_UNAVAILABLE" });
    const providerResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [recipient], subject: template.subject, html: template.html })
    });
    if (!providerResponse.ok) {
      console.error("[email-provider-error]", { status: providerResponse.status, template: input.type });
      throw Object.assign(new Error("Email provider rejected the request."), { statusCode: 502, code: "EMAIL_PROVIDER_REJECTED" });
    }
    await writeSecurityAudit(security.supabase, {
      userId: security.user.id,
      type: "API_EMAIL_SENT",
      endpoint: "email.send",
      ip: getClientIp(req),
      metadata: { template: input.type, target: input.targetUserId ? "authorized_user" : "self" }
    });
    return res.status(202).json({ accepted: true, template: input.type });
  } catch (error) {
    if (error?.name === "ZodError") return res.status(400).json({ error: "Invalid email request.", code: "INVALID_REQUEST" });
    return sendError(res, error);
  }
}

async function resolveRecipient(supabase, user, input) {
  if (input.type === "security_alert") {
    const sender = String(process.env.RESEND_FROM || process.env.VITE_RESEND_FROM || "");
    const configured = String(process.env.SECURITY_ALERT_RECIPIENT || sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "").trim().toLowerCase();
    if (!configured) throw Object.assign(new Error("Security alert recipient is not configured."), { statusCode: 503 });
    return configured;
  }
  const targetUserId = input.targetUserId || user.id;
  if (targetUserId !== user.id) {
    if (input.type !== "investment_group_invite" || !input.groupId) throw Object.assign(new Error("Cross-user email is not allowed."), { statusCode: 403 });
    const { data: group } = await supabase.from("investment_groups").select("owner_user_id").eq("id", input.groupId).single();
    if (group?.owner_user_id !== user.id && user.app_metadata?.role !== "admin") throw Object.assign(new Error("Group invitation permission denied."), { statusCode: 403 });
  }
  const { data, error } = await supabase.auth.admin.getUserById(targetUserId);
  const email = String(data?.user?.email || "").trim().toLowerCase();
  if (error || !email) throw Object.assign(new Error("Authorized recipient does not have an email address."), { statusCode: 404 });
  return email;
}
