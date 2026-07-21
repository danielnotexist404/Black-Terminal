import { applyCors, requireFields, requireUser, sendError } from "../../portfolio-api.js";
import { assertNetworkCapability } from "../permissions.js";
import { badRequest, cleanText, enforceSocialRateLimit, ensureNetworkProfile } from "../social-utils.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    await ensureNetworkProfile(supabase, user);
    const type = String(req.query?.type || req.body?.type || "all");
    if (!["all", "indicator", "strategy"].includes(type)) throw badRequest("Unsupported professional asset type.");
    if (req.method === "GET") return listAssets(req, res, supabase, user, type);
    if (req.method === "POST") return publishAsset(req, res, supabase, user, type);
    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    return sendError(res, error);
  }
}

async function listAssets(req, res, supabase, user, type) {
  let ownerId = user.id;
  if (req.query?.handle) {
    const { data: profile, error } = await supabase.from("profiles_extended").select("user_id").eq("handle", String(req.query.handle).toLowerCase()).maybeSingle();
    if (error) throw error;
    if (!profile) return res.status(200).json({ indicators: [], strategies: [] });
    ownerId = profile.user_id;
  }
  const own = ownerId === user.id;
  const indicatorQuery = supabase.from("published_indicators").select("id,user_id,name,description,version,visibility,metadata,created_at,updated_at").eq("user_id", ownerId).order("updated_at", { ascending: false });
  const strategyQuery = supabase.from("published_strategies").select("id,user_id,name,description,market,timeframe,risk_profile,visibility,metadata,created_at,updated_at").eq("user_id", ownerId).order("updated_at", { ascending: false });
  if (!own) {
    indicatorQuery.eq("visibility", "public");
    strategyQuery.eq("visibility", "public");
  }
  const [indicators, strategies] = await Promise.all([
    type === "strategy" ? Promise.resolve({ data: [], error: null }) : indicatorQuery,
    type === "indicator" ? Promise.resolve({ data: [], error: null }) : strategyQuery
  ]);
  if (indicators.error) throw indicators.error;
  if (strategies.error) throw strategies.error;
  return res.status(200).json({ indicators: indicators.data || [], strategies: strategies.data || [] });
}

async function publishAsset(req, res, supabase, user, type) {
  await enforceSocialRateLimit(supabase, user.id, "asset_publish", 12, 86400);
  if (type === "all") throw badRequest("Choose an indicator or strategy asset type.");
  requireFields(req.body, ["name", "description"]);
  const visibility = ["public", "followers", "private"].includes(req.body.visibility) ? req.body.visibility : "public";
  if (type === "indicator") {
    assertNetworkCapability(user, "can_publish_indicators");
    const { data, error } = await supabase.from("published_indicators").insert({
      user_id: user.id,
      name: cleanText(req.body.name, 120, true),
      description: cleanText(req.body.description, 3000, true),
      version: cleanText(req.body.version, 30) || "1.0.0",
      visibility,
      metadata: publicMetadata(req.body.metadata)
    }).select("*").single();
    if (error) throw error;
    return res.status(201).json({ asset: data });
  }
  assertNetworkCapability(user, "can_publish_strategies");
  const riskProfile = ["conservative", "balanced", "aggressive", "custom"].includes(req.body.riskProfile) ? req.body.riskProfile : "balanced";
  const { data, error } = await supabase.from("published_strategies").insert({
    user_id: user.id,
    name: cleanText(req.body.name, 120, true),
    description: cleanText(req.body.description, 3000, true),
    market: cleanText(req.body.market, 80) || null,
    timeframe: cleanText(req.body.timeframe, 30) || null,
    risk_profile: riskProfile,
    visibility,
    metadata: publicMetadata(req.body.metadata)
  }).select("*").single();
  if (error) throw error;
  return res.status(201).json({ asset: data });
}

function publicMetadata(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowed = ["markets", "timeframes", "category", "documentation_url", "backtest_status", "risk_note"];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
