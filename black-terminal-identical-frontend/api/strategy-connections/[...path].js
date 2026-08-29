import { handleStrategyConnectionRequest } from "../../server/routes/strategy-connections.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";
import { validateTradingRequest } from "../../server/security/trading-schemas.js";

export default async function handler(req, res) {
  try {
    const path = normalizePath(req.query?.path, req);
    const action = path.length === 1 && path[0] === "connect" ? "connect" : path.length === 1 ? "connection" : "list";
    const security = await requireApiSecurity(req, res, {
      endpoint: `strategy-connections.${action}`,
      permission: "execution.connectBroker",
      maxBytes: 32 * 1024,
      rateLimit: { perMinute: req.method === "GET" ? 60 : 10, perDay: req.method === "GET" ? 10_000 : 200 }
    });
    if (security.handled) return;
    validateTradingRequest(req, "strategyConnection", action);
    return handleStrategyConnectionRequest(req, res, security, path);
  } catch (error) {
    return sendError(res, error);
  }
}

function normalizePath(value, req) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return String(value).split("/").filter(Boolean);
  try {
    const pathname = new URL(req.url || "", "https://black-terminal.local").pathname;
    const marker = "/api/strategy-connections/";
    const index = pathname.indexOf(marker);
    return (index >= 0 ? pathname.slice(index + marker.length) : "").split("/").map(decodeURIComponent).filter(Boolean);
  } catch {
    return [];
  }
}
