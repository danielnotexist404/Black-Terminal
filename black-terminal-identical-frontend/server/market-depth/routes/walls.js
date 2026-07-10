import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { normalizeMarketKind, normalizeSymbol, normalizeVenue } from "../types.js";

export default async function walls(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const venue = normalizeVenue(req.query?.venue || req.query?.exchange);
    const marketKind = normalizeMarketKind(req.query?.marketKind);
    const symbol = normalizeSymbol(req.query?.symbol);
    const supabase = getSupabaseAdmin();
    let builder = supabase
      .from("market_liquidity_walls")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(250);
    if (venue) builder = builder.eq("venue", venue);
    if (marketKind) builder = builder.eq("market_kind", marketKind);
    if (symbol) builder = builder.eq("symbol", symbol);
    const { data, error } = await builder;
    if (error) throw error;
    return res.status(200).json({
      status: "ok",
      source: "black-core-market-depth-memory",
      walls: data || []
    });
  } catch (error) {
    return sendError(res, error);
  }
}
