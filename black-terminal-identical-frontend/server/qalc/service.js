import { readFile } from "node:fs/promises";
import { httpError, writeSecurityAudit } from "../security/securityMiddleware.js";

const allowedSymbols = new Set(["BTCUSDT", "ETHUSDT"]);
const allowedHorizons = new Set([250, 500, 1000, 3000, 5000, 10000]);

export async function handleQalcRequest(req, res, security, path) {
  const [resource, id, action] = path;
  if (req.method === "GET" && resource === "status") return res.status(200).json(await runtimeStatus());
  if (resource !== "strategies") throw httpError(404, "BC-QALC route not found.", "QALC_ROUTE_NOT_FOUND");
  if (req.method === "GET" && !id) return listStrategies(res, security);
  if (req.method === "POST" && !id) return createStrategy(req, res, security);
  if (req.method === "GET" && id && !action) return getStrategy(res, security, id);
  if (req.method === "PATCH" && id && !action) return updateStrategy(req, res, security, id);
  if (req.method === "POST" && id && action === "state") return changeState(req, res, security, id);
  throw httpError(405, "BC-QALC method not allowed.", "QALC_METHOD_NOT_ALLOWED");
}

async function runtimeStatus() {
  const path = process.env.QALC_STATE_PATH || "/var/lib/black-terminal/qalc/state/current.json";
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return { available: true, source: "VPS_CANONICAL_QALC_WORKER", ...parsed };
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(JSON.stringify({ level: "error", event: "qalc_state_read_failed", code: error?.code || "READ_FAILED" }));
    return { available: false, source: "NO_FALLBACK", certificationState: "RESEARCH", runtimeState: "STOPPED", reason: "QALC_WORKER_STATE_UNAVAILABLE" };
  }
}

async function listStrategies(res, { supabase, user }) {
  const { data, error } = await supabase.from("qalc_strategy_configs").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });
  if (error) throw databaseError(error);
  return res.status(200).json({ strategies: data || [] });
}

async function getStrategy(res, { supabase, user }, id) {
  const row = await ownedStrategy(supabase, user.id, id);
  return res.status(200).json({ strategy: row });
}

async function createStrategy(req, res, { supabase, user }) {
  const input = normalizeConfig(req.body || {});
  const { data, error } = await supabase.from("qalc_strategy_configs").insert({ user_id: user.id, ...input }).select("*").single();
  if (error) throw databaseError(error);
  await writeSecurityAudit(supabase, { userId: user.id, type: "QALC_RESEARCH_CONFIG_CREATED", severity: "INFO", endpoint: "qalc.strategies", metadata: { strategyId: data.id, symbol: data.symbol, mode: data.mode } });
  return res.status(201).json({ strategy: data });
}

async function updateStrategy(req, res, { supabase, user }, id) {
  const current = await ownedStrategy(supabase, user.id, id);
  if (current.desired_state === "ACTIVE") throw httpError(409, "Pause the Paper candidate before changing its configuration.", "QALC_ACTIVE_CONFIG_IMMUTABLE");
  const input = normalizeConfig({ ...current, ...(req.body || {}) });
  const { data, error } = await supabase.from("qalc_strategy_configs").update({ ...input, revision: Number(current.revision || 1) + 1, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", user.id).select("*").single();
  if (error) throw databaseError(error);
  return res.status(200).json({ strategy: data });
}

async function changeState(req, res, { supabase, user, identity }, id) {
  const row = await ownedStrategy(supabase, user.id, id);
  const desired = String(req.body?.state || "").toUpperCase();
  if (!["ACTIVE", "PAUSED", "STOPPED"].includes(desired)) throw httpError(400, "Invalid BC-QALC runtime state.", "QALC_STATE_INVALID");
  if (desired === "ACTIVE") {
    if (row.mode !== "PAPER") throw httpError(409, "Only an explicitly configured Paper candidate can start.", "QALC_PAPER_MODE_REQUIRED");
    if (row.certification_state === "RESEARCH") throw httpError(409, "Event replay certification is required before Paper activation.", "QALC_EVENT_REPLAY_CERTIFICATION_REQUIRED");
    if (!process.env.QALC_ALLOW_PAPER_CANDIDATES || process.env.QALC_ALLOW_PAPER_CANDIDATES !== "true") throw httpError(503, "The VPS Paper-candidate gate is disabled.", "QALC_PAPER_GATE_DISABLED");
  }
  const { data, error } = await supabase.from("qalc_strategy_configs").update({ desired_state: desired, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", user.id).select("*").single();
  if (error) throw databaseError(error);
  await writeSecurityAudit(supabase, { userId: user.id, type: `QALC_${desired}`, severity: desired === "ACTIVE" ? "WARN" : "INFO", endpoint: "qalc.strategies.state", metadata: { strategyId: id, mode: row.mode, actorRole: identity.role } });
  return res.status(200).json({ strategy: data });
}

async function ownedStrategy(supabase, userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw httpError(400, "Invalid BC-QALC strategy identity.", "QALC_ID_INVALID");
  const { data, error } = await supabase.from("qalc_strategy_configs").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw databaseError(error);
  if (!data) throw httpError(404, "BC-QALC strategy not found.", "QALC_STRATEGY_NOT_FOUND");
  return data;
}

function normalizeConfig(body) {
  const name = String(body.name || "").trim().slice(0, 80);
  const symbol = String(body.symbol || "BTCUSDT").toUpperCase();
  const mode = String(body.mode || "RESEARCH").toUpperCase();
  if (name.length < 3) throw httpError(400, "Strategy name must contain at least three characters.", "QALC_NAME_INVALID");
  if (!allowedSymbols.has(symbol)) throw httpError(400, "BC-QALC symbol is not allowed.", "QALC_SYMBOL_INVALID");
  if (!["RESEARCH", "PAPER", "SHADOW"].includes(mode)) throw httpError(400, "BC-QALC mode is invalid.", "QALC_MODE_INVALID");
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};
  const horizon = Number(config.predictionHorizonMs || 1000);
  if (!allowedHorizons.has(horizon)) throw httpError(400, "Prediction horizon is not allowed.", "QALC_HORIZON_INVALID");
  return {
    name, engine_id: "black-core-qalc", venue: "BYBIT", symbol, category: "linear", mode,
    paper_equity: bounded(config.paperEquity, 100, 100_000_000, 10_000),
    strategy_allocation_percent: bounded(config.strategyAllocationPercent, 0.1, 100, 10),
    config: {
      predictionHorizonMs: horizon,
      minimumNetEdgeMultiplier: bounded(config.minimumNetEdgeMultiplier, 1, 10, 2),
      maximumToxicity: bounded(config.maximumToxicity, 1, 100, 44),
      minimumFillProbability: bounded(config.minimumFillProbability, 0.01, 0.99, 0.35),
      quoteLifetimeMs: bounded(config.quoteLifetimeMs, 100, 5_000, 500),
      maximumQuoteActionsPerSecond: bounded(config.maximumQuoteActionsPerSecond, 1, 10, 2),
      maximumInventoryDurationMs: bounded(config.maximumInventoryDurationMs, 500, 60_000, 10_000),
      riskPerTradePercent: bounded(config.riskPerTradePercent, 0.001, 1, 0.02),
      maximumDailyLossPercent: bounded(config.maximumDailyLossPercent, 0.05, 5, 0.5),
      hardStopTicks: bounded(config.hardStopTicks, 1, 100, 8),
      maximumConsecutiveLosses: bounded(config.maximumConsecutiveLosses, 1, 20, 4),
      latencyProfile: "MEASURED_CONSERVATIVE",
      quoteSide: "ONE_SIDED_AUTOMATIC", orderType: "POST_ONLY", quotePlacement: "QUEUE_OPTIMIZED",
      liveExecutionEnabled: false, groupFanoutEnabled: false, withdrawalCapability: false,
    },
  };
}

function bounded(value, minimum, maximum, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
function databaseError(error) { const result = httpError(503, "BC-QALC persistence is unavailable.", "QALC_PERSISTENCE_UNAVAILABLE"); result.cause = error?.code; return result; }
