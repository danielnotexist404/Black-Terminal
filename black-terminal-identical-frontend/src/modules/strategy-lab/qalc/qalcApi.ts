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
  };
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
  list: (signal?: AbortSignal) => request<{ strategies: QalcSavedStrategy[] }>("strategies", {}, signal),
  create: (draft: QalcDraft) => request<{ strategy: QalcSavedStrategy }>("strategies", { method: "POST", body: JSON.stringify(draft) }),
  update: (id: string, draft: QalcDraft) => request<{ strategy: QalcSavedStrategy }>(`strategies/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(draft) }),
  state: (id: string, state: "ACTIVE" | "PAUSED" | "STOPPED") => request<{ strategy: QalcSavedStrategy }>(`strategies/${encodeURIComponent(id)}/state`, { method: "POST", body: JSON.stringify({ state }) }),
};

export const defaultQalcDraft = (): QalcDraft => ({
  name: "BC-QALC BTC Paper Candidate", symbol: "BTCUSDT", mode: "PAPER",
  config: { paperEquity: 10_000, strategyAllocationPercent: 10, predictionHorizonMs: 1000, minimumNetEdgeMultiplier: 2, maximumToxicity: 44, minimumFillProbability: 0.35, quoteLifetimeMs: 500, maximumQuoteActionsPerSecond: 2, maximumInventoryDurationMs: 10_000, riskPerTradePercent: 0.02, maximumDailyLossPercent: 0.5, hardStopTicks: 8, maximumConsecutiveLosses: 4 },
});
