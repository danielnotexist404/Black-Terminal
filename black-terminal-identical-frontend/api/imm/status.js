import { sendError } from "../../server/portfolio-api.js";
import { getIMMSystemStatus } from "../../server/imm/status-service.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";

export default async function status(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const security = await requireApiSecurity(req, res, { endpoint: "imm.status", maxBytes: 8192, rateLimit: { perMinute: 30, perDay: 5000 } });
    if (security.handled) return;
    const supabase = security.supabase;
    const verboseRequested = String(req.query?.verbose || "").toLowerCase() === "true";
    const token = req.headers["x-imm-admin-token"] || req.headers["X-IMM-Admin-Token"];
    const verbose = Boolean(verboseRequested && process.env.IMM_ADMIN_STATUS_TOKEN && token === process.env.IMM_ADMIN_STATUS_TOKEN);
    const payload = await getIMMSystemStatus(supabase, { verbose });
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(res, error);
  }
}
