import joinRequest from "../../../../server/network/routes/investment-group-join-request.js";
import messages from "../../../../server/network/routes/investment-group-messages.js";
import reviewRequest from "../../../../server/network/routes/investment-group-review-request.js";
import moderation from "../../../../server/network/routes/investment-group-moderation.js";
import { sendError } from "../../../../server/portfolio-api.js";
import { requireApiSecurity } from "../../../../server/security/securityMiddleware.js";

const handlers = {
  "join-request": joinRequest,
  messages,
  "review-request": reviewRequest,
  moderation
};

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || "").replace(/\.js$/, "");
    const routeHandler = handlers[action];
    if (!routeHandler) return res.status(404).json({ error: "Unknown investment group route." });
    const security = await requireApiSecurity(req, res, { endpoint: `network.investment-group.${action}`, maxBytes: 128 * 1024, rateLimit: { perMinute: 60, perDay: 10000 } });
    if (security.handled) return;
    return routeHandler(req, res);
  } catch (error) {
    return sendError(res, error);
  }
}
