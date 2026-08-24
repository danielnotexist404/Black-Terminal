export type ConsolidatedLiquiditySnapshotLike = {
  state: "live" | "degraded" | "initializing";
  sourceLevels: number;
  coverageRatio: number;
  rows: Array<{ bidBase: number; askBase: number }>;
  includedVenues: unknown[];
};

export type ConsolidatedLiquidityQuality = {
  populatedRows: number;
  sourceLevels: number;
  coverageRatio: number;
  venueCount: number;
  populated: boolean;
};

const EPSILON = 1e-12;

export function assessConsolidatedLiquiditySnapshot(snapshot: ConsolidatedLiquiditySnapshotLike): ConsolidatedLiquidityQuality {
  const populatedRows = snapshot.rows.reduce((count, row) => count + (
    Number(row.bidBase) > EPSILON || Number(row.askBase) > EPSILON ? 1 : 0
  ), 0);
  const sourceLevels = Number.isFinite(snapshot.sourceLevels) ? Math.max(0, snapshot.sourceLevels) : 0;
  const coverageRatio = Number.isFinite(snapshot.coverageRatio) ? clamp(snapshot.coverageRatio, 0, 1) : 0;
  const venueCount = Array.isArray(snapshot.includedVenues) ? snapshot.includedVenues.length : 0;
  return {
    populatedRows,
    sourceLevels,
    coverageRatio,
    venueCount,
    populated: populatedRows > 0 && sourceLevels > 0 && venueCount > 0
  };
}

/**
 * A temporary loss of the wide-depth carrier must not erase a previously
 * verified ladder. The lower-coverage frame is still truthful, but it is not
 * an authoritative replacement for the last broad snapshot and is therefore
 * retained only as a degraded refresh signal.
 */
export function shouldRetainPreviousConsolidatedSnapshot(
  previous: ConsolidatedLiquiditySnapshotLike | null | undefined,
  incoming: ConsolidatedLiquiditySnapshotLike
) {
  if (!previous) return false;
  const prior = assessConsolidatedLiquiditySnapshot(previous);
  const next = assessConsolidatedLiquiditySnapshot(incoming);
  if (!prior.populated) return false;
  if (!next.populated) return true;

  const sourceCollapse = prior.sourceLevels >= 2_000 && next.sourceLevels < prior.sourceLevels * 0.35;
  const coverageCollapse = prior.coverageRatio >= 0.35 && next.coverageRatio < prior.coverageRatio * 0.35;
  const populatedRowCollapse = prior.populatedRows >= 12 && next.populatedRows < prior.populatedRows * 0.25;
  return sourceCollapse || coverageCollapse || populatedRowCollapse;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
