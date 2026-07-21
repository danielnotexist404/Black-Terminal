import connectionHandler from "../../server/routes/cloud-execution/connection.js";
import intentHandler from "../../server/routes/cloud-execution/intent.js";
import mandateHandler from "../../server/routes/cloud-execution/mandate.js";
import statusHandler from "../../server/routes/cloud-execution/status.js";
import controlHandler from "../../server/routes/cloud-execution/control.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";
import { validateTradingRequest } from "../../server/security/trading-schemas.js";

const handlers = { connection: connectionHandler, control: controlHandler, intent: intentHandler, mandate: mandateHandler, status: statusHandler };

export default async function handler(req, res) {
  try {
    const path = normalizeCloudPath(req.query?.path, req);
    const route = path[0];
    const target = handlers[route];
    if (!target) return res.status(404).json({ error: "Black Cloud execution route not found." });
    const security = await requireApiSecurity(req, res, { endpoint: `cloud-execution.${route}`, permission: "execution.managePositions", maxBytes: 128 * 1024, rateLimit: { perMinute: 30, perDay: 5000 } });
    if (security.handled) return;
    validateTradingRequest(req, "cloud", route);
    return target(req, res);
  } catch (error) {
    return sendError(res, error);
  }
}

export function normalizeCloudPath(value, req) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return String(value).split("/").filter(Boolean);
  try {
    const pathname = new URL(req.url || "", "https://black-terminal.local").pathname;
    const marker = "/api/cloud-execution/";
    const index = pathname.indexOf(marker);
    return (index >= 0 ? pathname.slice(index + marker.length) : "").split("/").map(decodeURIComponent).filter(Boolean);
  } catch {
    return [];
  }
}
