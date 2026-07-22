import alerts from "../../server/market-depth/routes/alerts.js";
import ingest from "../../server/market-depth/routes/ingest.js";
import historicalTiles from "../../server/market-depth/routes/historical-tiles.js";
import prune from "../../server/market-depth/routes/prune.js";
import replay from "../../server/market-depth/routes/replay.js";
import status from "../../server/market-depth/routes/status.js";
import tiles from "../../server/market-depth/routes/tiles.js";
import walls from "../../server/market-depth/routes/walls.js";
import { enforceAnonymousSecurity, requireApiSecurity } from "../../server/security/securityMiddleware.js";
import { sendError } from "../../server/portfolio-api.js";

const handlers = {
  alerts,
  "historical-tiles": historicalTiles,
  ingest,
  prune,
  replay,
  status,
  tiles,
  walls
};

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || "").replace(/\.js$/, "");
    const routeHandler = handlers[action];
    if (!routeHandler) return res.status(404).json({ error: "Unknown market depth memory route." });
    if (["ingest", "prune"].includes(action)) {
      const security = await enforceAnonymousSecurity(req, res, { endpoint: `market-depth.${action}`, maxBytes: 2 * 1024 * 1024, rateLimit: { perMinute: 120, perDay: 100000 } });
      if (security.handled) return;
    } else {
      const security = await requireApiSecurity(req, res, { endpoint: `market-depth.${action}`, maxBytes: 32768, rateLimit: { perMinute: 60, perDay: 10000 } });
      if (security.handled) return;
    }
    return routeHandler(req, res);
  } catch (error) {
    return sendError(res, error);
  }
}
