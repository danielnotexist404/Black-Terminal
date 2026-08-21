import type { PortfolioSnapshot } from "./types";

export const PORTFOLIO_STALE_AFTER_MS = 30_000;

export function markPortfolioSnapshotFallback(snapshot: PortfolioSnapshot, error: unknown): PortfolioSnapshot {
  const now = Date.now();
  const reference = snapshot.freshness.brokerSyncedAt ?? snapshot.freshness.fetchedAt;
  const ageMs = Math.max(0, now - reference);
  const detail = error instanceof Error ? error.message : String(error || "Authoritative refresh failed.");
  return {
    ...snapshot,
    positions: snapshot.positions.map((position) => ({ ...position, snapshotStatus: "stale" })),
    freshness: {
      ...snapshot.freshness,
      status: ageMs >= snapshot.freshness.staleAfterMs ? "stale" : "degraded",
      source: "last-verified",
      fetchedAt: now,
      ageMs,
      quarantinedPositionCount: snapshot.positions.length,
      message: `Showing no position as live because the authoritative broker refresh failed: ${detail}`
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
    quarantinedPositionCount: 0,
    message
  };
}
