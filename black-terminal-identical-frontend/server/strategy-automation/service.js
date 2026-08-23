import {
  addTarget,
  configurePaper,
  controlPaper,
  createStrategy,
  createStrategyDraft,
  disconnectTarget,
  getBinding,
  getBindingData,
  getPaperData,
  getStrategySnapshot,
  getStrategyWorkspace,
  listEligibleTargets,
  listStrategies,
  publishStrategyDraft,
  renameStrategy,
  reorderTargets,
  setTargetState,
  saveStrategyDraft,
  startStrategyVersion,
  updateTargetPolicy
} from "./repository.js";
import { assertSlotIndex, normalizeMarketType, normalizeTargetType, strategyError } from "./domain.js";
import { parseStrategyBody, strategySchemas } from "./schemas.js";

export async function handleStrategyAutomationRequest(req, res, security, path) {
  const clean = path.map((item) => String(item)).filter(Boolean);
  if (clean.length === 0) return root(req, res, security);
  if (clean.length === 1 && clean[0] === "drafts" && req.method === "POST") {
    const body = parseStrategyBody(strategySchemas.create, req.body);
    return res.status(201).json(await createStrategyDraft(security.supabase, security.user.id, body, requireIdempotencyKey(req)));
  }
  const strategyId = clean[0];
  if (!isUuid(strategyId)) throw strategyError(400, "STRATEGY_ID_INVALID", "Strategy identifier is invalid.");
  if (clean.length === 1) {
    if (req.method === "GET") return res.status(200).json(await getStrategyWorkspace(security.supabase, security.user.id, strategyId));
    if (req.method === "PATCH") return res.status(200).json(await renameStrategy(security.supabase, security.user.id, strategyId, parseStrategyBody(strategySchemas.save, req.body), requireIdempotencyKey(req)));
  }
  if (clean[1] === "draft" && clean.length === 2 && req.method === "PATCH") {
    requireIdempotencyKey(req);
    return res.status(200).json(await saveStrategyDraft(security.supabase, security.user.id, strategyId, parseStrategyBody(strategySchemas.draft, req.body)));
  }
  if (clean[1] === "publish" && clean.length === 2 && req.method === "POST") {
    requireIdempotencyKey(req);
    return res.status(200).json(await publishStrategyDraft(security.supabase, security.user.id, strategyId, parseStrategyBody(strategySchemas.publish, req.body)));
  }
  if (clean[1] === "versions" && clean.length === 4 && clean[3] === "start" && req.method === "POST") {
    requireIdempotencyKey(req);
    const version = Number(clean[2]);
    return res.status(200).json(await startStrategyVersion(security.supabase, security.user.id, strategyId, parseStrategyBody(strategySchemas.startVersion, { version })));
  }
  if (clean[1] === "eligible-targets" && clean.length === 2 && req.method === "GET") {
    return res.status(200).json(await listEligibleTargets(security.supabase, security.user.id, strategyId));
  }
  if (clean[1] === "snapshot" && clean.length === 2 && req.method === "GET") {
    return res.status(200).json(await getStrategySnapshot(security.supabase, security.user.id, strategyId));
  }
  if (clean[1] === "paper") return paper(req, res, security, strategyId, clean.slice(2));
  if (clean[1] === "targets") return targets(req, res, security, strategyId, clean.slice(2));
  throw strategyError(404, "STRATEGY_ROUTE_NOT_FOUND", "Strategy automation route not found.");
}

async function root(req, res, security) {
  if (req.method === "GET") return res.status(200).json({ strategies: await listStrategies(security.supabase, security.user.id) });
  if (req.method === "POST") {
    const body = parseStrategyBody(strategySchemas.create, req.body);
    const key = requireIdempotencyKey(req);
    return res.status(201).json(await createStrategy(security.supabase, security.user.id, body, key));
  }
  throw methodNotAllowed();
}

async function paper(req, res, security, strategyId, path) {
  if (path.length === 0 && req.method === "GET") return res.status(200).json(await getPaperData(security.supabase, security.user.id, strategyId));
  if (path.length !== 1 || req.method !== "POST") throw methodNotAllowed();
  const action = path[0];
  const idempotencyKey = requireIdempotencyKey(req);
  if (action === "configure") return res.status(200).json({ paper: await configurePaper(security.supabase, security.user.id, strategyId, parseStrategyBody(strategySchemas.paperPolicy, req.body), idempotencyKey) });
  if (action === "top-up") return res.status(200).json({ paper: await controlPaper(security.supabase, security.user.id, strategyId, action, parseStrategyBody(strategySchemas.paperTopUp, req.body), idempotencyKey) });
  if (action === "reset") return res.status(200).json({ paper: await controlPaper(security.supabase, security.user.id, strategyId, action, parseStrategyBody(strategySchemas.paperReset, req.body), idempotencyKey) });
  if (action === "start" || action === "pause") return res.status(200).json({ paper: await controlPaper(security.supabase, security.user.id, strategyId, action, parseStrategyBody(strategySchemas.paperControl, req.body), idempotencyKey) });
  throw strategyError(404, "PAPER_ACTION_INVALID", "Paper target action not found.");
}

async function targets(req, res, security, strategyId, path) {
  if (path.length === 0) {
    if (req.method === "GET") {
      const workspace = await getStrategyWorkspace(security.supabase, security.user.id, strategyId);
      return res.status(200).json({ bindings: workspace.bindings, snapshots: workspace.snapshots });
    }
    if (req.method === "POST") {
      const body = parseStrategyBody(strategySchemas.addTarget, req.body);
      body.slotIndex = assertSlotIndex(body.slotIndex);
      body.targetType = normalizeTargetType(body.targetType);
      body.marketType = normalizeMarketType(body.marketType);
      return res.status(201).json({ binding: await addTarget(security.supabase, security.user.id, strategyId, body, requireIdempotencyKey(req)) });
    }
    throw methodNotAllowed();
  }
  if (path.length === 1 && path[0] === "reorder" && req.method === "POST") {
    const body = parseStrategyBody(strategySchemas.reorderTargets, req.body);
    return res.status(200).json(await reorderTargets(security.supabase, security.user.id, strategyId, body, requireIdempotencyKey(req)));
  }
  const bindingId = path[0];
  if (!isUuid(bindingId)) throw strategyError(400, "STRATEGY_TARGET_ID_INVALID", "Target binding identifier is invalid.");
  if (path.length === 1) {
    if (req.method === "GET") return res.status(200).json({ binding: await getBinding(security.supabase, security.user.id, strategyId, bindingId) });
    if (req.method === "PATCH") return res.status(200).json({ binding: await updateTargetPolicy(security.supabase, security.user.id, strategyId, bindingId, parseStrategyBody(strategySchemas.targetPolicy, req.body), requireIdempotencyKey(req)) });
    if (req.method === "DELETE") {
      const body = parseStrategyBody(strategySchemas.disconnect, req.body);
      return res.status(200).json({ binding: await disconnectTarget(security.supabase, security.user.id, strategyId, bindingId, body.expectedVersion, body.disconnectPolicy, requireIdempotencyKey(req)) });
    }
  }
  if (path.length === 2 && ["arm", "pause", "resume"].includes(path[1]) && req.method === "POST") {
    const body = parseStrategyBody(strategySchemas.targetControl, req.body);
    return res.status(200).json({ binding: await setTargetState(security.supabase, security.user.id, strategyId, bindingId, path[1], body.expectedVersion, requireIdempotencyKey(req)) });
  }
  if (path.length === 2 && ["snapshot", "members", "positions", "orders", "executions", "trades", "analytics", "risk", "logs"].includes(path[1]) && req.method === "GET") {
    return res.status(200).json({ [path[1]]: await getBindingData(security.supabase, security.user.id, strategyId, bindingId, path[1]) });
  }
  throw strategyError(404, "STRATEGY_TARGET_ROUTE_NOT_FOUND", "Strategy target route not found.");
}

function requireIdempotencyKey(req) {
  const key = String(req.headers?.["idempotency-key"] || req.headers?.["x-idempotency-key"] || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw strategyError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid idempotency key is required for this strategy mutation.");
  return key;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

function methodNotAllowed() {
  return strategyError(405, "STRATEGY_METHOD_NOT_ALLOWED", "Method not allowed for this strategy route.");
}
