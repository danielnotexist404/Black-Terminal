import { handleEventAlphaRequest } from "../../server/event-alpha/service.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";

export default async function handler(req, res) {
  try {
    const path = normalizePath(req.query?.path, req);
    const mutating = req.method !== "GET";
    const security = await requireApiSecurity(req, res, {
      endpoint: `event-alpha.${path.slice(0, 3).join(".") || "root"}`,
      maxBytes: mutating ? 512 * 1024 : 32 * 1024,
      rateLimit: { perMinute: mutating ? 20 : 120, perDay: mutating ? 2_000 : 25_000 }
    });
    if (security.handled) return;
    return handleEventAlphaRequest(req, res, security, path);
  } catch (error) {
    return sendError(res, error);
  }
}

export function normalizePath(value, req) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return String(value).split("/").filter(Boolean);
  try {
    const pathname = new URL(req.url || "", "https://black-terminal.local").pathname;
    const marker = "/api/event-alpha/";
    const index = pathname.indexOf(marker);
    return (index >= 0 ? pathname.slice(index + marker.length) : "").split("/").map(decodeURIComponent).filter(Boolean);
  } catch {
    return [];
  }
}
