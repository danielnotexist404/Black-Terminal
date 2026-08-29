import type { Timeframe } from "../../../market-data/types.ts";
import type { AuctionProfileSettings } from "./types.ts";

export const AUCTION_TIMEFRAME_SECONDS: Partial<Record<Timeframe, number>> = {
  "1s": 1, "10s": 10, "30s": 30, "1m": 60, "3m": 180, "5m": 300,
  "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "3h": 10_800,
  "4h": 14_400, "6h": 21_600, "8h": 28_800, "12h": 43_200, "1d": 86_400,
  "1w": 604_800, "1M": 2_592_000
};

const TPO_SOURCE_FRAMES: Array<{ seconds: number; timeframe: Timeframe }> = Object.entries(AUCTION_TIMEFRAME_SECONDS)
  .filter((entry): entry is [Timeframe, number] => Number.isFinite(entry[1]) && entry[1] <= 86_400)
  .map(([timeframe, seconds]) => ({ timeframe, seconds }))
  .sort((left, right) => left.seconds - right.seconds);

export function resolveAuctionTpoSourceTimeframe(bracketMinutes: number): Timeframe {
  const requested = Math.max(60, Math.round(bracketMinutes * 60));
  const descending = [...TPO_SOURCE_FRAMES].reverse();
  return descending.find(candidate => candidate.seconds <= requested && requested % candidate.seconds === 0)?.timeframe
    ?? descending.find(candidate => candidate.seconds <= requested)?.timeframe
    ?? "1m";
}

export function resolveAuctionLowerSourceTimeframe(settings: AuctionProfileSettings): Timeframe {
  return settings.calculationEngine === "TPO"
    ? resolveAuctionTpoSourceTimeframe(settings.tpoBracketMinutes)
    : settings.lowerTimeframe;
}

export function auctionProfileNeedsLowerHistory(chartTimeframe: Timeframe, settings: AuctionProfileSettings) {
  if (settings.implementationMode !== "BLACK_CORE_NATIVE") return false;
  const source = resolveAuctionLowerSourceTimeframe(settings);
  return (AUCTION_TIMEFRAME_SECONDS[source] ?? Number.POSITIVE_INFINITY) < (AUCTION_TIMEFRAME_SECONDS[chartTimeframe] ?? 0);
}
