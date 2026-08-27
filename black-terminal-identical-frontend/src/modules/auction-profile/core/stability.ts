import type { AuctionProfileSnapshot } from "./types.ts";

/**
 * A settings rebuild is allowed to replace the displayed model only after it
 * has produced at least one certified range. Empty intermediate generations
 * must never erase a valid RADAP snapshot from the chart.
 */
export function retainCertifiedRadapSnapshots(
  current: readonly AuctionProfileSnapshot[],
  candidate: readonly AuctionProfileSnapshot[],
  causalCutoffEnd?: number
) {
  const withinCausalCutoff = (snapshot: AuctionProfileSnapshot) =>
    causalCutoffEnd === undefined || snapshot.range.end <= causalCutoffEnd;
  const certifiedCandidate = candidate.filter(withinCausalCutoff);
  if (certifiedCandidate.length) return [...certifiedCandidate];
  return current.filter(withinCausalCutoff);
}
