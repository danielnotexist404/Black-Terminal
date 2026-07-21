import { z } from "zod";
import { sendError } from "../../portfolio-api.js";
import { getClientIp } from "../http-security.js";
import { requireApiSecurity, writeSecurityAudit } from "../securityMiddleware.js";

const eventSchema = z.object({
  tag: z.enum(["CREATE", "LOGIN", "LOGOUT", "SUSPEND", "REACTIVATE", "DELETE", "ERROR", "STATUS", "INDICATOR", "SYSTEM", "WEBHOOK"])
}).strict();

const EVENT_DESCRIPTIONS = Object.freeze({
  CREATE: "Authenticated account creation event recorded.",
  LOGIN: "Authenticated session login event recorded.",
  LOGOUT: "Authenticated session logout event recorded.",
  SUSPEND: "Administrative suspension event recorded.",
  REACTIVATE: "Administrative reactivation event recorded.",
  DELETE: "Administrative deletion event recorded.",
  ERROR: "Security-sensitive client error event recorded.",
  STATUS: "Authenticated status-change event recorded.",
  INDICATOR: "Administrative indicator-permission event recorded.",
  SYSTEM: "Authenticated system-policy event recorded.",
  WEBHOOK: "Authenticated webhook event recorded."
});

export async function handleAudit(req, res) {
  try {
    if (!["GET", "POST", "OPTIONS"].includes(req.method)) return res.status(405).json({ error: "Method Not Allowed" });
    const security = await requireApiSecurity(req, res, {
      endpoint: "audit.event",
      maxBytes: 8 * 1024,
      rateLimit: { perMinute: 30, perDay: 3000 }
    });
    if (security.handled) return;
    if (req.method === "GET") {
      if (security.identity.role !== "admin") throw Object.assign(new Error("Administrator access required."), { statusCode: 403 });
      const { data, error } = await security.supabase.from("bt_audit_logs").select("timestamp,tag,message,created_at").order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      return res.status(200).json({ logs: data || [] });
    }
    const input = eventSchema.parse(req.body);
    const { error } = await security.supabase.from("bt_audit_logs").insert({
      timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" }),
      tag: input.tag,
      message: EVENT_DESCRIPTIONS[input.tag]
    });
    if (error) throw error;
    await writeSecurityAudit(security.supabase, {
      userId: security.user.id,
      type: `CLIENT_${input.tag}`,
      severity: input.tag === "ERROR" ? "WARNING" : "INFO",
      endpoint: "audit.event",
      ip: getClientIp(req),
      metadata: { tag: input.tag }
    });
    return res.status(202).json({ accepted: true });
  } catch (error) {
    if (error?.name === "ZodError") return res.status(400).json({ error: "Invalid audit event.", code: "INVALID_REQUEST" });
    return sendError(res, error);
  }
}
