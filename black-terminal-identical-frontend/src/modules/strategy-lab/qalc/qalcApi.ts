import { supabase } from "../../../lib/supabase";
import { getLocalDocument, listLocalDocuments, putLocalDocument } from "../../../core/local-runtime/localDocumentStore";
import { isLocalOnlyRuntime } from "../../../core/local-runtime/localRuntimeClient";
import { activateLocalQalcRuntime, getLocalQalcRuntimeStatus, getLocalQalcTimeline, stopLocalQalcRuntime } from "./localQalcRuntime";

export type QalcSavedStrategy = {
  id: string; name: string; symbol: "BTCUSDT" | "ETHUSDT"; mode: "RESEARCH" | "PAPER" | "SHADOW";
  desired_state: "STOPPED" | "ACTIVE" | "PAUSED"; certification_state: string;
  paper_equity: number; strategy_allocation_percent: number; config: QalcDraft["config"];
  revision: number; updated_at: string;
};

export type QalcDraft = {
  name: string; symbol: "BTCUSDT" | "ETHUSDT"; mode: "PAPER";
  config: {
    paperEquity: number; strategyAllocationPercent: number; predictionHorizonMs: number;
    minimumNetEdgeMultiplier: number; maximumToxicity: number; minimumFillProbability: number;
    quoteLifetimeMs: number; maximumQuoteActionsPerSecond: number; maximumInventoryDurationMs: number;
    riskPerTradePercent: number; maximumDailyLossPercent: number; hardStopTicks: number; maximumConsecutiveLosses: number;
    indicatorConfigHash?: string; indicatorConfigVersion?: number; chartDisplayMode?: "LIVE" | "REPLAY" | "COMBINED";
    chartMarkerSize?: number; chartPaneHeight?: number; sourceRunId?: string;
  };
};
export type QalcDraftSeed = Omit<Partial<QalcDraft>, "config"> & { config?: Partial<QalcDraft["config"]> };

export type QalcChartEventKind = "CANDIDATE_LONG" | "CANDIDATE_SHORT" | "REJECTED" | "QUOTE_BID" | "QUOTE_ASK" | "QUOTE_CANCELLED" | "QUOTE_EXPIRED" | "PARTIAL_FILL" | "ENTRY_LONG" | "ENTRY_SHORT" | "EXIT_LONG" | "EXIT_SHORT";
export type QalcChartEvent = {
  schemaVersion: 1; id: string; engineId: "black-core-qalc"; strategyId: string; runId: string; modelVersion: string;
  venue: "BYBIT"; category: "linear"; symbol: "BTCUSDT" | "ETHUSDT"; kind: QalcChartEventKind;
  eventTime: number; receiveTime: number; price: number; quantity: number; side?: "BUY" | "SELL"; direction?: "LONG" | "SHORT";
  reason: string; sourceEventId: string; decisionId?: string; orderId?: string; fillId?: string; positionCycleId?: string;
  origin: "RESEARCH" | "REPLAY" | "PAPER" | "SHADOW"; certificationState: string;
  metrics: { probabilityUp?: number; probabilityDown?: number; expectedMoveTicks?: number; expectedNetEdgeUsdt?: number; allInCostUsdt?: number; fillProbability?: number; toxicity?: number; queueAhead?: number; queueConfidence?: number; feeSource?: string; projectedTargetPrice?: number; invalidationPrice?: number; expiresAt?: number; quoteEligible?: boolean };
};
export type QalcTimelineResponse = {
  available: boolean; source: "VPS_CANONICAL_QALC_TIMELINE" | "LOCAL_QALC_TIMELINE" | "NO_FALLBACK"; updatedAt: number;
  coverage: { firstEventAt?: number; lastEventAt?: number; complete: false; source: "RECORDED_QALC_EVENT_TIME" };
  events: QalcChartEvent[]; nextCursor?: string; reason?: string;
};

export type QalcRuntimeStatus = {
  available: boolean; source: string; certificationState: string; runtimeState: string; updatedAt?: number;
  book?: { state: string; ageMs: number; bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }> };
  clock?: { state: string; offsetMs: number; driftMsPerMinute: number };
  features?: any; decision?: any; activeQuote?: any; inventory?: any; risk?: any; executions?: any[]; recentAudit?: any[]; counters?: Record<string, number>;
};

async function request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  if (!supabase) throw new Error("BC-QALC requires an authenticated session.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to use BC-QALC.");
  const response = await fetch(`/api/qalc/${path}`, { ...options, signal, cache: "no-store", headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() } : {}), ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `BC-QALC request failed (${response.status}).`);
  return payload as T;
}

const LOCAL_QALC_NAMESPACE = "qalc-strategies";

function validateDraft(draft: QalcDraft) {
  if (draft.name.trim().length < 3 || draft.name.trim().length > 120) throw new Error("BC-QALC strategy name must contain 3 to 120 characters.");
  if (!(["BTCUSDT", "ETHUSDT"] as const).includes(draft.symbol)) throw new Error("BC-QALC supports only its declared linear markets.");
  const numericValues = Object.entries(draft.config).filter(([, value]) => typeof value === "number") as Array<[string, number]>;
  if (numericValues.some(([, value]) => !Number.isFinite(value) || value < 0)) throw new Error("BC-QALC numeric settings must be finite and non-negative.");
  if (draft.config.paperEquity <= 0) throw new Error("Paper equity must be greater than zero.");
  if (draft.config.strategyAllocationPercent <= 0 || draft.config.strategyAllocationPercent > 100) throw new Error("Strategy allocation must be greater than zero and no more than 100%.");
}

async function listLocalStrategies(): Promise<{ strategies: QalcSavedStrategy[] }> {
  const documents = await listLocalDocuments<QalcSavedStrategy>(LOCAL_QALC_NAMESPACE);
  return { strategies: documents.map((item) => item.value).sort((left, right) => right.updated_at.localeCompare(left.updated_at)) };
}

async function createLocalStrategy(draft: QalcDraft): Promise<{ strategy: QalcSavedStrategy }> {
  validateDraft(draft);
  const id = crypto.randomUUID();
  const strategy: QalcSavedStrategy = {
    id,
    name: draft.name.trim(),
    symbol: draft.symbol,
    mode: "PAPER",
    desired_state: "STOPPED",
    certification_state: "RESEARCH",
    paper_equity: draft.config.paperEquity,
    strategy_allocation_percent: draft.config.strategyAllocationPercent,
    config: structuredClone(draft.config),
    revision: 1,
    updated_at: new Date().toISOString(),
  };
  await putLocalDocument(LOCAL_QALC_NAMESPACE, id, strategy, 0);
  return { strategy };
}

async function updateLocalStrategy(id: string, draft: QalcDraft): Promise<{ strategy: QalcSavedStrategy }> {
  validateDraft(draft);
  const current = await getLocalDocument<QalcSavedStrategy>(LOCAL_QALC_NAMESPACE, id);
  if (!current) throw new Error("The local BC-QALC configuration no longer exists.");
  if (current.value.desired_state === "ACTIVE") throw new Error("Pause this local BC-QALC Paper runtime before changing its deterministic configuration.");
  const strategy: QalcSavedStrategy = {
    ...current.value,
    name: draft.name.trim(),
    symbol: draft.symbol,
    paper_equity: draft.config.paperEquity,
    strategy_allocation_percent: draft.config.strategyAllocationPercent,
    config: structuredClone(draft.config),
    revision: current.value.revision + 1,
    updated_at: new Date().toISOString(),
  };
  await putLocalDocument(LOCAL_QALC_NAMESPACE, id, strategy, current.revision);
  return { strategy };
}

async function setLocalStrategyState(id: string, state: "ACTIVE" | "PAUSED" | "STOPPED"): Promise<{ strategy: QalcSavedStrategy }> {
  const current = await getLocalDocument<QalcSavedStrategy>(LOCAL_QALC_NAMESPACE, id);
  if (!current) throw new Error("The local BC-QALC configuration no longer exists.");
  const strategy: QalcSavedStrategy = {
    ...current.value,
    desired_state: state,
    revision: current.value.revision + 1,
    updated_at: new Date().toISOString(),
  };
  if (state === "ACTIVE") {
    const documents = await listLocalDocuments<QalcSavedStrategy>(LOCAL_QALC_NAMESPACE);
    const otherActive = documents.find((document) => document.key !== id && document.value.desired_state === "ACTIVE");
    if (otherActive) throw new Error(`Pause ${otherActive.value.name} before starting another local BC-QALC Paper runtime.`);
    await activateLocalQalcRuntime(strategy);
    try {
      await putLocalDocument(LOCAL_QALC_NAMESPACE, id, strategy, current.revision);
    } catch (cause) {
      await stopLocalQalcRuntime(id, "STOPPED").catch(() => undefined);
      throw cause;
    }
  } else {
    await putLocalDocument(LOCAL_QALC_NAMESPACE, id, strategy, current.revision);
    await stopLocalQalcRuntime(id, state);
  }
  return { strategy };
}

export const qalcApi = {
  status: (signal?: AbortSignal) => isLocalOnlyRuntime() ? getLocalQalcRuntimeStatus() : request<QalcRuntimeStatus>("status", {}, signal),
  timeline: (params: { symbol: string; from?: number; to?: number; runId?: string; limit?: number }, signal?: AbortSignal) => {
    if (isLocalOnlyRuntime()) return getLocalQalcTimeline(params);
    const query = new URLSearchParams({ symbol: params.symbol, limit: String(params.limit ?? 1_000) });
    if (Number.isFinite(params.from)) query.set("from", String(params.from));
    if (Number.isFinite(params.to)) query.set("to", String(params.to));
    if (params.runId) query.set("runId", params.runId);
    return request<QalcTimelineResponse>(`timeline?${query}`, {}, signal);
  },
  list: (signal?: AbortSignal) => isLocalOnlyRuntime() ? listLocalStrategies() : request<{ strategies: QalcSavedStrategy[] }>("strategies", {}, signal),
  create: (draft: QalcDraft) => isLocalOnlyRuntime() ? createLocalStrategy(draft) : request<{ strategy: QalcSavedStrategy }>("strategies", { method: "POST", body: JSON.stringify(draft) }),
  update: (id: string, draft: QalcDraft) => isLocalOnlyRuntime() ? updateLocalStrategy(id, draft) : request<{ strategy: QalcSavedStrategy }>(`strategies/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(draft) }),
  state: (id: string, state: "ACTIVE" | "PAUSED" | "STOPPED") => isLocalOnlyRuntime() ? setLocalStrategyState(id, state) : request<{ strategy: QalcSavedStrategy }>(`strategies/${encodeURIComponent(id)}/state`, { method: "POST", body: JSON.stringify({ state }) }),
};

export const defaultQalcDraft = (seed?: QalcDraftSeed): QalcDraft => {
  const base: QalcDraft = {
    name: "BC-QALC BTC Paper Candidate", symbol: "BTCUSDT", mode: "PAPER",
    config: { paperEquity: 10_000, strategyAllocationPercent: 10, predictionHorizonMs: 1000, minimumNetEdgeMultiplier: 2, maximumToxicity: 44, minimumFillProbability: 0.35, quoteLifetimeMs: 500, maximumQuoteActionsPerSecond: 2, maximumInventoryDurationMs: 10_000, riskPerTradePercent: 0.02, maximumDailyLossPercent: 0.5, hardStopTicks: 8, maximumConsecutiveLosses: 4 },
  };
  return { ...base, ...seed, mode: "PAPER", config: { ...base.config, ...seed?.config } };
};
