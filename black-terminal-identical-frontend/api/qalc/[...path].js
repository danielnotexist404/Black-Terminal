import { handleQalcRequest } from "../../server/qalc/service.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";

export default async function handler(req, res) {
  try {
    const path = normalizePath(req.query?.path, req);
    const mutating = req.method !== "GET";
    const security = await requireApiSecurity(req, res, {
      endpoint: `qalc.${path.slice(0, 4).join(".") || "root"}`,
      permission: "execution.managePositions",
      maxBytes: mutating ? 64 * 1024 : 16 * 1024,
      rateLimit: { perMinute: mutating ? 20 : 120, perDay: mutating ? 1_000 : 25_000 },
    });
    if (security.handled) return;
    return handleQalcRequest(req, res, security, path);
  } catch (error) { return sendError(res, error); }
}

function normalizePath(value, req) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return String(value).split("/").filter(Boolean);
  try { const pathname = new URL(req.url || "", "https://black-terminal.local").pathname; const marker = "/api/qalc/"; return pathname.slice(pathname.indexOf(marker) + marker.length).split("/").map(decodeURIComponent).filter(Boolean); }
  catch { return []; }
}
