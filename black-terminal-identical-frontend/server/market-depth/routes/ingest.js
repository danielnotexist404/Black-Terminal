import { applyCors, getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { MarketDepthMemoryEngine } from "../storage.js";

const engine = new MarketDepthMemoryEngine();

export default async function ingest(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    requireIngestToken(req);
    const supabase = getSupabaseAdmin();
    const summary = await engine.ingest(supabase, req.body || {});
    return res.status(200).json({
      status: "accepted",
      source: "black-core-market-depth-memory",
      summary
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function requireIngestToken(req) {
  const configured = process.env.MARKET_DEPTH_INGEST_TOKEN;
  if (!configured) {
    const error = new Error("Market depth ingest token is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const provided = req.headers["x-bt-depth-token"] || req.headers["X-BT-Depth-Token"];
  if (provided !== configured) {
    const error = new Error("Invalid market depth ingest token.");
    error.statusCode = 401;
    throw error;
  }
}
