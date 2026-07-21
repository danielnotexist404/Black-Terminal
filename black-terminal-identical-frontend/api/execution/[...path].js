import order from "../../server/routes/execution/order.js";
import cancel from "../../server/routes/execution/cancel.js";
import modify from "../../server/routes/execution/modify.js";
import cancelAll from "../../server/routes/execution/cancel-all.js";
import positionAction from "../../server/routes/execution/position-action.js";
import protection from "../../server/routes/execution/protection.js";
import accountMode from "../../server/routes/execution/account-mode.js";
import strategy from "../../server/routes/execution/strategy.js";
import { applyCors, sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";
import { validateTradingRequest } from "../../server/security/trading-schemas.js";

const routes = new Map([
  ["order", order],
  ["cancel", cancel],
  ["modify", modify],
  ["cancel-all", cancelAll],
  ["position-action", positionAction],
  ["protection", protection],
  ["account-mode", accountMode],
  ["strategy", strategy]
]);

export default async function handler(req, res) {
  try {
    const path = normalizePath(req.query.path, req, "execution");
    const route = routes.get(path[0]);
    if (route) {
      const security = await requireApiSecurity(req, res, { endpoint: `execution.${path[0]}`, permission: "execution.managePositions", maxBytes: 128 * 1024, rateLimit: { perMinute: 60, perDay: 10000 } });
      if (security.handled) return;
      validateTradingRequest(req, "execution", path[0]);
      return route(req, res);
    }

    if (applyCors(req, res)) return;
    return res.status(404).json({ error: "Execution route not found." });
  } catch (error) {
    if (res.headersSent) throw error;
    return sendError(res, error);
  }
}

function normalizePath(value, req, baseSegment) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return [String(value)];

  try {
    const pathname = new URL(req.url || "", "https://black-terminal.local").pathname;
    const marker = `/api/${baseSegment}/`;
    const markerIndex = pathname.indexOf(marker);
    const remainder = markerIndex >= 0
      ? pathname.slice(markerIndex + marker.length)
      : pathname.replace(/^\/+/, "");
    return remainder
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .filter(Boolean)
      .filter((segment, index, all) => !(index === 0 && segment === "api") && !(index === 1 && all[0] === "api" && segment === baseSegment));
  } catch {
    return [];
  }
  return [];
}
