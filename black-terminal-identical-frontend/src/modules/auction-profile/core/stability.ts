import type { AuctionProfileSnapshot } from "./types.ts";

/**
 * A settings rebuild is allowed to replace the displayed model only after it
 * has produced at least one certified range. Empty intermediate generations
 * must never erase a valid RADAP snapshot from the chart.
 */
export function retainCertifiedRadapSnapshots(
  current: readonly AuctionProfileSnapshot[],
  candidate: readonly AuctionProfileSnapshot[]
) {
  return candidate.length ? [...candidate] : [...current];
}

