import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { getHistoricalBookHeatmapTiles } from "../../book-heatmap/historical-tile-engine.js";

export default async function historicalTiles(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });
  try {
    return res.status(200).json(await getHistoricalBookHeatmapTiles(getSupabaseAdmin(), req.query || {}));
  } catch (error) {
    return sendError(res, error);
  }
}
