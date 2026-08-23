import { supabase } from "../../../lib/supabase";

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
  available: boolean; source: "VPS_CANONICAL_QALC_TIMELINE" | "NO_FALLBACK"; updatedAt: number;
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

export const qalcApi = {
  status: (signal?: AbortSignal) => request<QalcRuntimeStatus>("status", {}, signal),
  timeline: (params: { symbol: string; from?: number; to?: number; runId?: string; limit?: number }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ symbol: params.symbol, limit: String(params.limit ?? 1_000) });
    if (Number.isFinite(params.from)) query.set("from", String(params.from));
    if (Number.isFinite(params.to)) query.set("to", String(params.to));
    if (params.runId) query.set("runId", params.runId);
    return request<QalcTimelineResponse>(`timeline?${query}`, {}, signal);
  },
  list: (signal?: AbortSignal) => request<{ strategies: QalcSavedStrategy[] }>("strategies", {}, signal),
  create: (draft: QalcDraft) => request<{ strategy: QalcSavedStrategy }>("strategies", { method: "POST", body: JSON.stringify(draft) }),
  update: (id: string, draft: QalcDraft) => request<{ strategy: QalcSavedStrategy }>(`strategies/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(draft) }),
  state: (id: string, state: "ACTIVE" | "PAUSED" | "STOPPED") => request<{ strategy: QalcSavedStrategy }>(`strategies/${encodeURIComponent(id)}/state`, { method: "POST", body: JSON.stringify({ state }) }),
};

export const defaultQalcDraft = (seed?: QalcDraftSeed): QalcDraft => {
  const base: QalcDraft = {
    name: "BC-QALC BTC Paper Candidate", symbol: "BTCUSDT", mode: "PAPER",
    config: { paperEquity: 10_000, strategyAllocationPercent: 10, predictionHorizonMs: 1000, minimumNetEdgeMultiplier: 2, maximumToxicity: 44, minimumFillProbability: 0.35, quoteLifetimeMs: 500, maximumQuoteActionsPerSecond: 2, maximumInventoryDurationMs: 10_000, riskPerTradePercent: 0.02, maximumDailyLossPercent: 0.5, hardStopTicks: 8, maximumConsecutiveLosses: 4 },
  };
  return { ...base, ...seed, mode: "PAPER", config: { ...base.config, ...seed?.config } };
};
