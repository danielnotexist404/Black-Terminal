import { normalizeSymbol, timestampMs } from "../normalization/canonicalEnvelope.ts";
import { bybitPublicGet } from "./bybitTransport.ts";

interface FundingResult { list: Array<{ symbol?: string; fundingRate: string; fundingRateTimestamp: string }> }

export interface BclifFundingPoint {
  symbol: string;
  timestamp: number;
  receivedTimestamp: number;
  availableAt: number;
  availabilityMode: "OFFICIAL_HISTORICAL_BACKFILL";
  fundingRate: number;
  certainty: "OBSERVED";
  sourceVersion: string;
}

export async function fetchBybitFundingHistory(input: {
  symbol: string;
  startTime: number;
  endTime: number;
  fundingIntervalMinutes: number;
  sourceVersion: string;
  signal?: AbortSignal;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const intervalMs = Math.max(60_000, input.fundingIntervalMinutes * 60_000);
  const output = new Map<number, BclifFundingPoint>();
  let pageEnd = input.endTime;
  for (let page = 0; page < 1_000 && pageEnd >= input.startTime; page++) {
    const pageStart = Math.max(input.startTime, pageEnd - intervalMs * 199);
    const result = await bybitPublicGet<FundingResult>("/v5/market/funding/history", new URLSearchParams({
      category: "linear",
      symbol,
      startTime: String(pageStart),
      endTime: String(pageEnd),
      limit: "200"
    }), { signal: input.signal });
    const receivedTimestamp = Date.now();
    for (const row of result.list || []) {
      const timestamp = timestampMs(row.fundingRateTimestamp);
      const fundingRate = Number(row.fundingRate);
      if (timestamp >= input.startTime && timestamp <= input.endTime && Number.isFinite(fundingRate)) {
        output.set(timestamp, { symbol, timestamp, receivedTimestamp, availableAt: receivedTimestamp, availabilityMode: "OFFICIAL_HISTORICAL_BACKFILL", fundingRate, certainty: "OBSERVED", sourceVersion: input.sourceVersion });
      }
    }
    if (pageStart === input.startTime) break;
    pageEnd = pageStart - 1;
  }
  return [...output.values()].sort((a, b) => a.timestamp - b.timestamp);
}
