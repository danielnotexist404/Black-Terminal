import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { getMarketDepthAlerts } from "../alert-engine.js";

export default async function alerts(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const supabase = getSupabaseAdmin();
    const payload = await getMarketDepthAlerts(supabase, req.query || {});
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(res, error);
  }
}
