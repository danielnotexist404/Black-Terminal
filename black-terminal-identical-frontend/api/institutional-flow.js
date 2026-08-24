import { getInstitutionalFlowSnapshot } from "../server/institutional-flow/runtime.js";
import { requireMethod, sendError } from "../server/portfolio-api.js";
import { requireApiSecurity } from "../server/security/securityMiddleware.js";

export default async function institutionalFlow(req, res) {
  try {
    requireMethod(req, "GET");
    const security = await requireApiSecurity(req, res, {
      endpoint: "institutional-flow.snapshot",
      maxBytes: 8_192,
      rateLimit: { perMinute: 90, perDay: 25_000 }
    });
    if (security.handled) return;
    const payload = await getInstitutionalFlowSnapshot({ asset: req.query?.asset });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Black-Core-Data-Source", "institutional-flow-intelligence");
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(res, error);
  }
}
