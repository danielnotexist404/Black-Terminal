import type { BclifCanonicalEvent, BclifOpenInterestPoint } from "../contracts.ts";
import { canonicalEvent, normalizeSymbol } from "./canonicalEnvelope.ts";

export function canonicalOpenInterestEvent(symbolValue: string, point: BclifOpenInterestPoint, receivedTimestamp: number): BclifCanonicalEvent<BclifOpenInterestPoint> {
  const symbol = normalizeSymbol(symbolValue);
  if (point.availableAt !== point.receivedTimestamp || receivedTimestamp !== point.receivedTimestamp) throw new Error("BCLIF OI availability clock is inconsistent");
  if (point.availabilityMode !== "LIVE_OBSERVATION" && point.availabilityMode !== "OFFICIAL_HISTORICAL_BACKFILL") throw new Error("BCLIF OI availability provenance is invalid");
  return canonicalEvent({
    eventId: `BYBIT:${symbol}:OI:${point.interval}:${point.timestamp}`,
    kind: "OPEN_INTEREST",
    symbol,
    exchangeTimestamp: point.timestamp,
    receivedTimestamp,
    sourceVersion: point.sourceVersion,
    payload: point
  });
}
