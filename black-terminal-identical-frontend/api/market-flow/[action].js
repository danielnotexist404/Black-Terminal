import { getSupabaseAdmin, requireMethod, sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";
import { readAuthenticCvdBars } from "../../server/market-flow/authenticCvdService.js";

export default async function marketFlow(req, res) {
  try {
    requireMethod(req, "GET");
    const action = String(req.query?.action || "").toLowerCase();
    if (action !== "cvd-bars") return res.status(404).json({ error: "Market-flow route not found.", code: "MARKET_FLOW_ROUTE_NOT_FOUND" });
    const security = await requireApiSecurity(req, res, {
      endpoint: "market-flow.cvd-bars",
      indicator: "acvdOscillator",
      maxBytes: 8_192,
      rateLimit: { perMinute: 20, perDay: 5_000 }
    });
    if (security.handled) return;
    const payload = await readAuthenticCvdBars(security.supabase, getSupabaseAdmin({ storageCompatible: true }), req.query);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Black-Core-Data-Source", "verified-bclif-aggressor-trades");
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(res, error);
  }
}
