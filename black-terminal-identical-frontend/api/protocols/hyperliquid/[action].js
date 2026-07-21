import cancel from "../../../server/protocols/hyperliquid-routes/cancel.js";
import closePosition from "../../../server/protocols/hyperliquid-routes/close-position.js";
import connect from "../../../server/protocols/hyperliquid-routes/connect.js";
import modify from "../../../server/protocols/hyperliquid-routes/modify.js";
import order from "../../../server/protocols/hyperliquid-routes/order.js";
import sync from "../../../server/protocols/hyperliquid-routes/sync.js";
import { sendError } from "../../../server/portfolio-api.js";
import { requireApiSecurity } from "../../../server/security/securityMiddleware.js";
import { validateTradingRequest } from "../../../server/security/trading-schemas.js";

const handlers = {
  cancel,
  "close-position": closePosition,
  connect,
  modify,
  order,
  sync
};

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || "").replace(/\.js$/, "");
    const routeHandler = handlers[action];
    if (!routeHandler) return res.status(404).json({ error: "Unknown Hyperliquid relay route." });
    const permission = action === "connect" ? "execution.connectWallet" : "execution.managePositions";
    const security = await requireApiSecurity(req, res, { endpoint: `hyperliquid.${action}`, permission, maxBytes: 128 * 1024, rateLimit: { perMinute: 60, perDay: 10000 } });
    if (security.handled) return;
    validateTradingRequest(req, "hyperliquid", action);
    return routeHandler(req, res);
  } catch (error) {
    return sendError(res, error);
  }
}
