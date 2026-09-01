import { supabase } from "../../lib/supabase";
import { getLocalDocument } from "../../core/local-runtime/localDocumentStore";
import { isLocalOnlyRuntime } from "../../core/local-runtime/localRuntimeClient";

export type EventAlphaRuntimeConfig = {
  engineEnabled: boolean;
  ingestionEnabled: boolean;
  tokenSupplyEnabled: boolean;
  governanceEnabled: boolean;
  protocolEconomicsEnabled: boolean;
  equityPeadEnabled: boolean;
  peadProviderConfigured: boolean;
  paperExecutionEnabled: boolean;
  paperExecutionConfigurationRejected: boolean;
  liveExecutionEnabled: false;
  liveExecutionConfigurationRejected: boolean;
  manualApprovalRequired: boolean;
  manualApprovalConfigurationRejected: boolean;
  strategyKillSwitchEngaged: boolean;
  globalExecutionKillSwitchEngaged: boolean;
  tokenUnlockSourceConfigured: boolean;
  governanceAdapterEnabled: boolean;
  governanceConfigurationRequested: boolean;
  protocolEconomicsAdapterEnabled: boolean;
  protocolEconomicsConfigurationRequested: boolean;
  llmExtractionEnabled: false;
  llmExtractionConfigurationRejected: boolean;
  architecture: "SERVER_AUTHORITY" | "LOCAL_AUTHORITY";
  executionMode: "PAPER" | "DISABLED";
  directBrokerFanout: false;
  llmOrderAuthority: false;
};

export type EventAlphaEvent = {
  id: string;
  canonical_key: string;
  event_family: "TOKEN_SUPPLY" | "GOVERNANCE" | "PROTOCOL_ECONOMICS";
  asset_id: string;
  symbol: string;
  event_time: string;
  first_actionable_at: string;
  status: string;
  current_revision: number;
  source_confidence: number;
  safe_summary: string;
  updated_at: string;
};

export type EventAlphaThesis = {
  id: string;
  canonical_event_id: string;
  thesis_key: string;
  state: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  event_family: string;
  confidence: number;
  remaining_alpha_bps: number;
  valid_from: string;
  expires_at: string;
  reason_codes: string[];
  version: number;
  updated_at: string;
};

export type CryptoDriftCandidate = EventAlphaThesis & {
  rank_score: number;
  market_verified: boolean;
  collapsed_event_count: number;
  event: Pick<EventAlphaEvent, "id" | "symbol" | "asset_id" | "event_family" | "event_time" | "first_actionable_at" | "status" | "safe_summary" | "source_confidence" | "current_revision">;
};

export type PeadSignal = {
  id: string;
  pead_event_id: string;
  evidence_id: string;
  signal_state: "POSITIVE_DRIFT" | "NEGATIVE_DRIFT" | "FULLY_PRICED" | "OVERREACTION" | "NO_TRADE";
  direction: "LONG" | "SHORT" | "NEUTRAL";
  eps_sue: number;
  revenue_sue: number;
  guidance_sue: number | null;
  margin_sue: number | null;
  composite_surprise: number;
  immediate_car_bps: number;
  total_car_bps: number;
  expected_drift_bps: number;
  remaining_drift_bps: number;
  confidence: number;
  reason_codes: string[];
  methodology_version: string;
  calculated_at: string;
  event: {
    id: string;
    ticker: string;
    issuer: string;
    fiscal_period: string;
    announced_at: string;
    first_actionable_at: string;
    expectation_as_of: string;
    announcement_session: string;
    status: string;
    current_revision: number;
    source_confidence: number;
  };
};

export type PeadDetail = {
  event: PeadSignal["event"] & Record<string, unknown>;
  evidence: Record<string, unknown>;
  signal: Omit<PeadSignal, "event">;
  returnPath: Array<{ point_index: number; observed_at: string; price: number | null; abnormal_return_bps: number; cumulative_abnormal_return_bps: number }>;
};

export type EventAlphaHealth = {
  config: EventAlphaRuntimeConfig;
  pendingJobs: number;
  sources: Array<{
    source_key: string;
    event_family: string;
    enabled: boolean;
    health_status: string;
    last_success_at: string | null;
    last_error_at: string | null;
    safe_error_code: string | null;
    updated_at: string;
  }>;
  peadProviders: Array<{
    provider_key: string;
    display_name: string;
    enabled: boolean;
    health_status: string;
    last_success_at: string | null;
    last_error_at: string | null;
    safe_error_code: string | null;
    updated_at: string;
  }>;
};

export type EventAlphaAudit = {
  id: string;
  decision_type: string;
  outcome: string;
  reason_codes: string[];
  actor_type: string;
  evidence_hash: string;
  created_at: string;
};

async function request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  if (!supabase) throw new Error("Event Alpha requires an authenticated session.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to open Event Alpha.");
  const response = await fetch(`/api/event-alpha/${path}`, {
    ...options,
    signal,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Event Alpha request failed (${response.status}).`);
  return payload as T;
}

type LocalEventAlphaState = {
  version: 1;
  config: EventAlphaRuntimeConfig;
  events: EventAlphaEvent[];
  theses: EventAlphaThesis[];
  cryptoCandidates: CryptoDriftCandidate[];
  peadSignals: PeadSignal[];
  peadDetails: Record<string, PeadDetail>;
  eventDetails: Record<string, Record<string, unknown>>;
  health: EventAlphaHealth;
  audit: EventAlphaAudit[];
};

const localConfig: EventAlphaRuntimeConfig = {
  engineEnabled: true,
  ingestionEnabled: false,
  tokenSupplyEnabled: false,
  governanceEnabled: false,
  protocolEconomicsEnabled: false,
  equityPeadEnabled: false,
  peadProviderConfigured: false,
  paperExecutionEnabled: false,
  paperExecutionConfigurationRejected: false,
  liveExecutionEnabled: false,
  liveExecutionConfigurationRejected: true,
  manualApprovalRequired: true,
  manualApprovalConfigurationRejected: false,
  strategyKillSwitchEngaged: true,
  globalExecutionKillSwitchEngaged: false,
  tokenUnlockSourceConfigured: false,
  governanceAdapterEnabled: false,
  governanceConfigurationRequested: false,
  protocolEconomicsAdapterEnabled: false,
  protocolEconomicsConfigurationRequested: false,
  llmExtractionEnabled: false,
  llmExtractionConfigurationRejected: true,
  architecture: "LOCAL_AUTHORITY",
  executionMode: "DISABLED",
  directBrokerFanout: false,
  llmOrderAuthority: false
};

function emptyLocalState(): LocalEventAlphaState {
  const now = new Date().toISOString();
  const health: EventAlphaHealth = {
    config: localConfig,
    pendingJobs: 0,
    sources: [{
      source_key: "local-evidence-provider",
      event_family: "ALL",
      enabled: false,
      health_status: "UNCONFIGURED",
      last_success_at: null,
      last_error_at: null,
      safe_error_code: "LOCAL_PROVIDER_REQUIRED",
      updated_at: now
    }],
    peadProviders: [{
      provider_key: "local-pead-provider",
      display_name: "Local PEAD Evidence Provider",
      enabled: false,
      health_status: "UNCONFIGURED",
      last_success_at: null,
      last_error_at: null,
      safe_error_code: "LOCAL_PROVIDER_REQUIRED",
      updated_at: now
    }]
  };
  return {
    version: 1,
    config: localConfig,
    events: [],
    theses: [],
    cryptoCandidates: [],
    peadSignals: [],
    peadDetails: {},
    eventDetails: {},
    health,
    audit: []
  };
}

async function localState(): Promise<LocalEventAlphaState> {
  const stored = await getLocalDocument<LocalEventAlphaState>("event-alpha", "state");
  const value = stored?.value;
  if (!value || value.version !== 1) return emptyLocalState();
  const fallback = emptyLocalState();
  const config: EventAlphaRuntimeConfig = {
    ...fallback.config,
    ...value.config,
    architecture: "LOCAL_AUTHORITY",
    directBrokerFanout: false,
    llmOrderAuthority: false,
    liveExecutionEnabled: false
  };
  return {
    ...fallback,
    ...value,
    config,
    events: Array.isArray(value.events) ? value.events : [],
    theses: Array.isArray(value.theses) ? value.theses : [],
    cryptoCandidates: Array.isArray(value.cryptoCandidates) ? value.cryptoCandidates : [],
    peadSignals: Array.isArray(value.peadSignals) ? value.peadSignals : [],
    peadDetails: value.peadDetails && typeof value.peadDetails === "object" ? value.peadDetails : {},
    eventDetails: value.eventDetails && typeof value.eventDetails === "object" ? value.eventDetails : {},
    audit: Array.isArray(value.audit) ? value.audit : [],
    health: value.health ? { ...value.health, config } : { ...fallback.health, config }
  };
}

export const eventAlphaApi = {
  config: async (signal?: AbortSignal) => isLocalOnlyRuntime() ? { config: (await localState()).config } : request<{ config: EventAlphaRuntimeConfig }>("config", {}, signal),
  feed: async (signal?: AbortSignal) => isLocalOnlyRuntime() ? { events: (await localState()).events.slice(0, 100) } : request<{ events: EventAlphaEvent[] }>("feed?limit=100", {}, signal),
  rankedCrypto: (filters: { family?: string; symbol?: string; minimumConfidence?: number } = {}, signal?: AbortSignal) => {
    if (isLocalOnlyRuntime()) return localState().then((state) => ({ candidates: state.cryptoCandidates
      .filter((row) => !filters.family || row.event.event_family === filters.family)
      .filter((row) => !filters.symbol || row.event.symbol === filters.symbol)
      .filter((row) => filters.minimumConfidence === undefined || Number(row.confidence) >= filters.minimumConfidence)
      .slice(0, 100) }));
    const query = new URLSearchParams({ limit: "100" });
    if (filters.family) query.set("family", filters.family);
    if (filters.symbol) query.set("symbol", filters.symbol);
    if (filters.minimumConfidence !== undefined) query.set("minimumConfidence", String(filters.minimumConfidence));
    return request<{ candidates: CryptoDriftCandidate[] }>(`crypto-ranked?${query}`, {}, signal);
  },
  theses: async (signal?: AbortSignal) => isLocalOnlyRuntime() ? { theses: (await localState()).theses.slice(0, 100) } : request<{ theses: EventAlphaThesis[] }>("theses?limit=100", {}, signal),
  health: async (signal?: AbortSignal) => isLocalOnlyRuntime() ? (await localState()).health : request<EventAlphaHealth>("health", {}, signal),
  audit: async (signal?: AbortSignal) => isLocalOnlyRuntime() ? { records: (await localState()).audit.slice(0, 100) } : request<{ records: EventAlphaAudit[] }>("audit?limit=100", {}, signal),
  eventDetail: async (id: string, signal?: AbortSignal) => isLocalOnlyRuntime() ? (await localState()).eventDetails[id] ?? {} : request<Record<string, unknown>>(`events/${encodeURIComponent(id)}`, {}, signal),
  peadSignals: (filters: { state?: string; ticker?: string } = {}, signal?: AbortSignal) => {
    if (isLocalOnlyRuntime()) return localState().then((state) => ({ signals: state.peadSignals
      .filter((row) => !filters.state || row.signal_state === filters.state)
      .filter((row) => !filters.ticker || row.event.ticker === filters.ticker)
      .slice(0, 100) }));
    const query = new URLSearchParams({ limit: "100" });
    if (filters.state) query.set("state", filters.state);
    if (filters.ticker) query.set("ticker", filters.ticker);
    return request<{ signals: PeadSignal[] }>(`pead/signals?${query}`, {}, signal);
  },
  peadDetail: async (id: string, signal?: AbortSignal) => {
    if (isLocalOnlyRuntime()) {
      const detail = (await localState()).peadDetails[id];
      if (!detail) throw new Error("Local PEAD evidence is not available for this signal.");
      return detail;
    }
    return request<PeadDetail>(`pead/signals/${encodeURIComponent(id)}`, {}, signal);
  },
  paperState: async (signal?: AbortSignal) => isLocalOnlyRuntime()
    ? { positions: [], orders: [], intents: [] }
    : request<{ positions: Record<string, unknown>[]; orders: Record<string, unknown>[]; intents: Record<string, unknown>[] }>("paper-state?limit=100", {}, signal)
};
