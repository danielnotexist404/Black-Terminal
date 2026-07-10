import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { getMarketDepthReplay } from "../replay-engine.js";

export default async function replay(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const supabase = getSupabaseAdmin();
    const replayPayload = await getMarketDepthReplay(supabase, req.query || {});
    return res.status(200).json(replayPayload);
  } catch (error) {
    return sendError(res, error);
  }
}
