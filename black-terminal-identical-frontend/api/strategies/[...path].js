import { handleStrategyAutomationRequest } from "../../server/strategy-automation/service.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";

export default async function handler(req, res) {
  try {
    const path = normalizeStrategyPath(req.query?.path, req);
    const mutating = req.method !== "GET";
    const security = await requireApiSecurity(req, res, {
      endpoint: `strategies.${path.slice(0, 4).join(".") || "root"}`,
      permission: "execution.managePositions",
      maxBytes: mutating ? 256 * 1024 : 32 * 1024,
      rateLimit: { perMinute: mutating ? 30 : 120, perDay: mutating ? 2_000 : 25_000 }
    });
    if (security.handled) return;
    return handleStrategyAutomationRequest(req, res, security, path);
  } catch (error) {
    return sendError(res, error);
  }
}

export function normalizeStrategyPath(value, req) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return String(value).split("/").filter(Boolean);
  try {
    const pathname = new URL(req.url || "", "https://black-terminal.local").pathname;
    const marker = "/api/strategies";
    const index = pathname.indexOf(marker);
    return (index >= 0 ? pathname.slice(index + marker.length) : "").split("/").map(decodeURIComponent).filter(Boolean);
  } catch {
    return [];
  }
}
