import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { getMarketDepthTiles } from "../tile-engine.js";

export default async function tiles(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const supabase = getSupabaseAdmin();
    const payload = await getMarketDepthTiles(supabase, req.query || {});
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(res, error);
  }
}
