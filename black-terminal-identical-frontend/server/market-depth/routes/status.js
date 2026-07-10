import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { readCollectorStatus } from "../collector-status.js";

export default async function status(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("market_depth_statistics")
      .select("venue,market_kind,symbol,resolution,bucket_start,best_bid,best_ask,mid_price,spread,total_bid_size,total_ask_size,imbalance,liquidity_score,update_count,packet_loss_count,reconnect_count,latency_ms")
      .order("bucket_start", { ascending: false })
      .limit(80);
    if (error) throw error;
    const collectors = await readCollectorStatus(supabase).catch(() => []);
    return res.status(200).json({
      status: "ok",
      source: "black-core-market-depth-memory",
      markets: data || [],
      collectors
    });
  } catch (error) {
    return sendError(res, error);
  }
}
