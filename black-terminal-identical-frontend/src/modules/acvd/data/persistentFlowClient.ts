import { supabase } from "../../../lib/supabase";
import { isLocalOnlyRuntime } from "../../../core/local-runtime/localRuntimeClient";
import type { AuthenticFlowBarInput, AcvdAuthority } from "../core/types";

export type PersistentFlowSnapshot = {
  version: 1;
  authority: AcvdAuthority;
  venue: string;
  symbol: string;
  timeframeSeconds: number;
  bars: AuthenticFlowBarInput[];
  coverage: { completeBars: number; pendingChunks: number; availableStart: number | null; availableEnd: number | null };
  warning: string | null;
};

export async function fetchPersistentAuthenticFlow(options: { venue: string; symbol: string; timeframeSeconds: number; start: number; end: number; signal?: AbortSignal }): Promise<PersistentFlowSnapshot> {
  if (isLocalOnlyRuntime()) throw new Error("Persistent authentic-flow archives are not present on this device; live public flow remains available.");
  if (!supabase) throw new Error("Authenticated Black Cloud flow history is unavailable.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to load authentic flow history.");
  const query = new URLSearchParams({ venue: options.venue, symbol: options.symbol, timeframeSeconds: String(options.timeframeSeconds), start: String(options.start), end: String(options.end) });
  const response = await fetch(`/api/market-flow/cvd-bars?${query}`, { method: "GET", cache: "no-store", signal: options.signal, headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(payload?.error || `Authentic flow request failed (${response.status}).`));
  return validate(payload, options);
}

function validate(payload: unknown, request: { venue: string; symbol: string; timeframeSeconds: number }): PersistentFlowSnapshot {
  const value = payload as PersistentFlowSnapshot;
  if (!value || value.version !== 1 || !Array.isArray(value.bars) || value.symbol !== request.symbol.toUpperCase() || value.timeframeSeconds !== request.timeframeSeconds) throw new Error("Authentic flow response failed its market identity contract.");
  for (const bar of value.bars) {
    if (!(Number.isFinite(bar.time) && Number.isFinite(bar.buyVolume) && Number.isFinite(bar.sellVolume) && Number.isFinite(bar.buyNotional) && Number.isFinite(bar.sellNotional))) throw new Error("Authentic flow response contains an invalid bar.");
  }
  return value;
}
