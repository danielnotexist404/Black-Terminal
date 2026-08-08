import { handleBclifAction } from "../../server/liquidation-intelligence/api/handlers.js";
import { BCLIF_INDICATOR_KEY, normalizeBclifRouteError, parseBclifAction } from "../../server/liquidation-intelligence/api/contracts.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";

const RATE_LIMITS = Object.freeze({
  status: { perMinute: 30, perDay: 5000 },
  health: { perMinute: 30, perDay: 5000 },
  coverage: { perMinute: 45, perDay: 7500 },
  manifest: { perMinute: 45, perDay: 7500 },
  tile: { perMinute: 90, perDay: 15000 },
  diagnostics: { perMinute: 15, perDay: 1000 }
});

export default async function handler(req, res) {
  try {
    const action = parseBclifAction(req.query?.action);
    const security = await requireApiSecurity(req, res, {
      endpoint: `liquidation-intelligence.${action}`,
      indicator: BCLIF_INDICATOR_KEY,
      maxBytes: 8192,
      rateLimit: RATE_LIMITS[action]
    });
    if (security.handled) return;
    return handleBclifAction(action, req, res, security);
  } catch (error) {
    return sendError(res, normalizeBclifRouteError(error));
  }
}
