import { normalizeSymbol, timestampMs } from "../normalization/canonicalEnvelope.ts";
import { bybitPublicGet } from "./bybitTransport.ts";

interface RatioResult {
  list: Array<{ symbol?: string; buyRatio: string; sellRatio: string; timestamp: string }>;
  nextPageCursor?: string;
}

export async function fetchBybitAccountRatios(input: {
  symbol: string;
  period: "5min" | "15min" | "30min" | "1h" | "4h" | "1d";
  startTime: number;
  endTime: number;
  sourceVersion: string;
  signal?: AbortSignal;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const output = new Map<number, { symbol: string; timestamp: number; receivedTimestamp: number; availableAt: number; availabilityMode: "OFFICIAL_HISTORICAL_BACKFILL"; longAccountRatio: number; shortAccountRatio: number; sourceVersion: string }>();
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 2_000; page++) {
    const params = new URLSearchParams({ category: "linear", symbol, period: input.period, startTime: String(input.startTime), endTime: String(input.endTime), limit: "500" });
    if (cursor) params.set("cursor", cursor);
    const result = await bybitPublicGet<RatioResult>("/v5/market/account-ratio", params, { signal: input.signal });
    const receivedTimestamp = Date.now();
    for (const row of result.list || []) {
      const timestamp = timestampMs(row.timestamp);
      const longAccountRatio = Number(row.buyRatio);
      const shortAccountRatio = Number(row.sellRatio);
      if (Number.isFinite(longAccountRatio) && Number.isFinite(shortAccountRatio)) {
        output.set(timestamp, { symbol, timestamp, receivedTimestamp, availableAt: receivedTimestamp, availabilityMode: "OFFICIAL_HISTORICAL_BACKFILL", longAccountRatio, shortAccountRatio, sourceVersion: input.sourceVersion });
      }
    }
    const next = String(result.nextPageCursor || "");
    if (!next || seen.has(next) || !result.list?.length) break;
    seen.add(next);
    cursor = next;
  }
  return [...output.values()].sort((a, b) => a.timestamp - b.timestamp);
}
