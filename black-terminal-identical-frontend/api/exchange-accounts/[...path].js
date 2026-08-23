import connect from "../../server/routes/exchange-accounts/connect.js";
import connectDemo from "../../server/routes/exchange-accounts/connect-demo.js";
import diagnostics from "../../server/routes/exchange-accounts/diagnostics.js";
import sync from "../../server/routes/exchange-accounts/sync.js";
import mainnetValidation from "../../server/routes/exchange-accounts/mainnet-validation.js";
import bybitRuntimeStatus from "../../server/routes/exchange-accounts/bybit-runtime-status.js";
import list from "../../server/routes/exchange-accounts/list.js";
import health from "../../server/routes/exchange-accounts/health.js";
import capabilities from "../../server/routes/exchange-accounts/capabilities.js";
import oauthStart from "../../server/routes/exchange-accounts/oauth-start.js";
import oauthCallback from "../../server/routes/exchange-accounts/oauth-callback.js";
import account from "../../server/routes/exchange-accounts/account.js";
import { applyCors, sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";
import { validateTradingRequest } from "../../server/security/trading-schemas.js";

const routes = new Map([
  ["connect", connect],
  ["connect-demo", connectDemo],
  ["diagnostics", diagnostics],
  ["sync", sync],
  ["mainnet-validation", mainnetValidation],
  ["bybit-runtime-status", bybitRuntimeStatus],
  ["list", list],
  ["health", health],
  ["capabilities", capabilities],
  ["oauth-start", oauthStart],
  ["oauth-callback", oauthCallback]
]);

export default async function handler(req, res) {
  try {
    const path = normalizePath(req.query.path, req, "exchange-accounts");
    const route = routes.get(path[0]);

    // OAuth callbacks are authenticated by a short-lived, one-time hashed state
    // record because the broker redirect cannot carry the user's bearer token.
    if (path[0] === "oauth-callback") return oauthCallback(req, res);

    if (route || (path.length === 1 && path[0])) {
      const permission = ["connect", "connect-demo", "list", "capabilities", "oauth-start"].includes(path[0]) ? "execution.connectBroker" : "execution.managePositions";
      const security = await requireApiSecurity(req, res, { endpoint: `exchange-accounts.${path[0]}`, permission, maxBytes: 128 * 1024, rateLimit: { perMinute: 30, perDay: 5000 } });
      if (security.handled) return;
      validateTradingRequest(req, "exchange", path[0]);
    }

    if (route) return route(req, res);
    if (path.length === 1 && path[0]) return account(req, res);

    if (applyCors(req, res)) return;
    return res.status(404).json({ error: "Exchange account route not found." });
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
