import alerts from "../../server/market-depth/routes/alerts.js";
import ingest from "../../server/market-depth/routes/ingest.js";
import prune from "../../server/market-depth/routes/prune.js";
import replay from "../../server/market-depth/routes/replay.js";
import status from "../../server/market-depth/routes/status.js";
import walls from "../../server/market-depth/routes/walls.js";

const handlers = {
  alerts,
  ingest,
  prune,
  replay,
  status,
  walls
};

export default async function handler(req, res) {
  const action = String(req.query?.action || "").replace(/\.js$/, "");
  const routeHandler = handlers[action];

  if (!routeHandler) {
    return res.status(404).json({ error: "Unknown market depth memory route." });
  }

  return routeHandler(req, res);
}
