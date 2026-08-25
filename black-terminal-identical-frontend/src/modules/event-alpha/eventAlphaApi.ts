import { supabase } from "../../lib/supabase";

export type EventAlphaRuntimeConfig = {
  engineEnabled: boolean;
  ingestionEnabled: boolean;
  tokenSupplyEnabled: boolean;
  governanceEnabled: boolean;
  protocolEconomicsEnabled: boolean;
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
  architecture: "SERVER_AUTHORITY";
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

export const eventAlphaApi = {
  config: (signal?: AbortSignal) => request<{ config: EventAlphaRuntimeConfig }>("config", {}, signal),
  feed: (signal?: AbortSignal) => request<{ events: EventAlphaEvent[] }>("feed?limit=100", {}, signal),
  theses: (signal?: AbortSignal) => request<{ theses: EventAlphaThesis[] }>("theses?limit=100", {}, signal),
  health: (signal?: AbortSignal) => request<EventAlphaHealth>("health", {}, signal),
  audit: (signal?: AbortSignal) => request<{ records: EventAlphaAudit[] }>("audit?limit=100", {}, signal),
  eventDetail: (id: string, signal?: AbortSignal) => request<Record<string, unknown>>(`events/${encodeURIComponent(id)}`, {}, signal),
  paperState: (signal?: AbortSignal) => request<{ positions: Record<string, unknown>[]; orders: Record<string, unknown>[]; intents: Record<string, unknown>[] }>("paper-state?limit=100", {}, signal)
};
