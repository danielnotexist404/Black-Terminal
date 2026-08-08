import type { BclifOpenInterestPoint } from "../contracts.ts";
import { normalizeSymbol, timestampMs } from "../normalization/canonicalEnvelope.ts";
import { bybitPublicGet } from "./bybitTransport.ts";

interface BybitOiResult {
  list: Array<{ openInterest: string; singleOpenInterest?: string; timestamp: string }>;
  nextPageCursor?: string;
}

type PublicGet = typeof bybitPublicGet;

export async function fetchBybitOpenInterestHistory(input: {
  symbol: string;
  interval: "5min" | "15min" | "30min" | "1h" | "4h" | "1d";
  startTime: number;
  endTime: number;
  sourceVersion: string;
  signal?: AbortSignal;
  get?: PublicGet;
}) {
  const symbol = normalizeSymbol(input.symbol);
  if (input.startTime >= input.endTime) throw new Error("OI backfill range is invalid");
  const get = input.get ?? bybitPublicGet;
  const rows: BclifOpenInterestPoint[] = [];
  const cursors = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 10_000; page++) {
    const params = new URLSearchParams({
      category: "linear",
      symbol,
      intervalTime: input.interval,
      startTime: String(input.startTime),
      endTime: String(input.endTime),
      limit: "200"
    });
    if (cursor) params.set("cursor", cursor);
    const result = await get<BybitOiResult>("/v5/market/open-interest", params, { signal: input.signal });
    const receivedTimestamp = Date.now();
    for (const row of result.list || []) {
      const bothSides = positiveOrNull(row.openInterest);
      const singleSide = row.singleOpenInterest == null ? (bothSides === null ? null : bothSides * 0.5) : positiveOrNull(row.singleOpenInterest);
      if (singleSide === null) continue;
      rows.push({
        timestamp: timestampMs(row.timestamp),
        receivedTimestamp,
        availableAt: receivedTimestamp,
        availabilityMode: "OFFICIAL_HISTORICAL_BACKFILL",
        interval: input.interval,
        singleSideOpenInterest: singleSide,
        bothSidesOpenInterest: bothSides,
        unit: "BASE",
        sourceVersion: input.sourceVersion
      });
    }
    const next = String(result.nextPageCursor || "");
    if (!next || cursors.has(next) || !result.list?.length) break;
    cursors.add(next);
    cursor = next;
    if (page === 9_999) throw new Error("OI backfill exceeded pagination safety bound");
  }
  const unique = new Map<string, BclifOpenInterestPoint>();
  for (const row of rows) unique.set(`${row.timestamp}:${row.interval}`, row);
  return [...unique.values()]
    .filter((row) => row.timestamp >= input.startTime && row.timestamp <= input.endTime)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function positiveOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
