import type { PortfolioSnapshot } from "./types.ts";

export const PORTFOLIO_STALE_AFTER_MS = 30_000;

export function markPortfolioSnapshotFallback(snapshot: PortfolioSnapshot, error: unknown): PortfolioSnapshot {
  const now = Date.now();
  const reference = snapshot.freshness.brokerSyncedAt ?? snapshot.freshness.fetchedAt;
  const ageMs = Math.max(0, now - reference);
  const detail = error instanceof Error ? error.message : String(error || "Authoritative refresh failed.");
  return {
    ...snapshot,
    freshness: {
      ...snapshot.freshness,
      status: ageMs >= snapshot.freshness.staleAfterMs ? "stale" : "degraded",
      source: "last-verified",
      fetchedAt: now,
      ageMs,
      message: `Showing the last verified broker snapshot: ${detail}`
    }
  };
}

export function withCurrentFreshnessAge(snapshot: PortfolioSnapshot): PortfolioSnapshot {
  const reference = snapshot.freshness.brokerSyncedAt ?? snapshot.freshness.fetchedAt;
  const ageMs = Math.max(0, Date.now() - reference);
  return { ...snapshot, freshness: { ...snapshot.freshness, ageMs } };
}

export function unavailablePortfolioFreshness(message: string): PortfolioSnapshot["freshness"] {
  return {
    status: "disconnected",
    source: "local-empty",
    fetchedAt: Date.now(),
    brokerSyncedAt: null,
    blockerCode: null,
    ageMs: 0,
    staleAfterMs: PORTFOLIO_STALE_AFTER_MS,
    message
  };
}
