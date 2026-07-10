import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { pruneMarketDepthMemory } from "../retention.js";

export default async function prune(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    requireMaintenanceToken(req);
    const supabase = getSupabaseAdmin();
    const payload = await pruneMarketDepthMemory(supabase, req.body?.policy);
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(res, error);
  }
}

function requireMaintenanceToken(req) {
  const configured = process.env.MARKET_DEPTH_MAINTENANCE_TOKEN || process.env.MARKET_DEPTH_INGEST_TOKEN;
  if (!configured) {
    const error = new Error("Market depth maintenance token is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const provided = req.headers["x-bt-depth-token"] || req.headers["X-BT-Depth-Token"];
  if (provided !== configured) {
    const error = new Error("Invalid market depth maintenance token.");
    error.statusCode = 401;
    throw error;
  }
}
