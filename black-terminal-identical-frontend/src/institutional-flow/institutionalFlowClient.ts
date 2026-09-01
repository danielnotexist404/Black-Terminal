import { supabase } from "../lib/supabase";
import { isLocalOnlyRuntime } from "../core/local-runtime/localRuntimeClient";
import type { InstitutionalFlowSnapshot } from "./types";

export async function fetchInstitutionalFlow(asset: string, signal?: AbortSignal): Promise<InstitutionalFlowSnapshot> {
  if (isLocalOnlyRuntime()) throw new Error("Institutional fund intelligence has no certified device-local data provider yet.");
  if (!supabase) throw new Error("Authenticated institutional intelligence is unavailable.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to load institutional intelligence.");
  const params = new URLSearchParams({ asset: normalizeAsset(asset) });
  const response = await fetch(`/api/institutional-flow?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(payload?.error || `Institutional intelligence request failed (${response.status}).`));
  return validateSnapshot(payload);
}

function validateSnapshot(payload: unknown): InstitutionalFlowSnapshot {
  const value = payload as InstitutionalFlowSnapshot;
  if (!value || value.version !== 1 || typeof value.asset !== "string" || !Array.isArray(value.funds) || !Array.isArray(value.oscillator)) {
    throw new Error("Institutional intelligence failed its data contract.");
  }
  return value;
}

function normalizeAsset(value: string) {
  return String(value || "BTC").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "BTC";
}
