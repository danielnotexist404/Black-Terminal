import { normalizeSymbol, timestampMs } from "../normalization/canonicalEnvelope.ts";
import { bybitPublicGet, bybitPublicGetEnvelope } from "./bybitTransport.ts";

interface TickerResult {
  list: Array<{
    symbol?: string;
    lastPrice: string;
    markPrice: string;
    indexPrice: string;
    openInterest: string;
    singleOpenInterest?: string;
    fundingRate?: string;
    bid1Price?: string;
    ask1Price?: string;
  }>;
}

interface KlineResult { list: string[][] }

export async function fetchBybitTicker(symbolValue: string, signal?: AbortSignal) {
  const symbol = normalizeSymbol(symbolValue);
  const response = await bybitPublicGetEnvelope<TickerResult>("/v5/market/tickers", new URLSearchParams({ category: "linear", symbol }), { signal });
  const result = response.result;
  const row = result.list?.[0];
  if (!row) throw new Error(`Bybit ticker unavailable for ${symbol}`);
  const lastPrice = positive(row.lastPrice, "last price");
  const markPrice = positive(row.markPrice, "mark price");
  const indexPrice = positive(row.indexPrice, "index price");
  const bothSidesOpenInterest = positive(row.openInterest, "open interest");
  const singleSideOpenInterest = row.singleOpenInterest == null ? bothSidesOpenInterest * 0.5 : positive(row.singleOpenInterest, "single-side open interest");
  return {
    symbol,
    timestamp: response.exchangeTimestamp,
    exchangeTimestamp: response.exchangeTimestamp,
    receivedTimestamp: response.receivedTimestamp,
    lastPrice,
    markPrice,
    indexPrice,
    basisBps: ((markPrice - indexPrice) / indexPrice) * 10_000,
    bothSidesOpenInterest,
    singleSideOpenInterest,
    fundingRate: finiteOrNull(row.fundingRate),
    bestBid: positiveOr(row.bid1Price, markPrice),
    bestAsk: positiveOr(row.ask1Price, markPrice)
  };
}

export async function fetchBybitPriceHistory(input: {
  symbol: string;
  kind: "mark" | "index";
  interval: string;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const path = input.kind === "mark" ? "/v5/market/mark-price-kline" : "/v5/market/index-price-kline";
  const output = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number }>();
  let end = input.endTime;
  for (let page = 0; page < 10_000 && end >= input.startTime; page++) {
    const result = await bybitPublicGet<KlineResult>(path, new URLSearchParams({ category: "linear", symbol, interval: input.interval, start: String(input.startTime), end: String(end), limit: "1000" }), { signal: input.signal });
    const rows = result.list || [];
    for (const row of rows) {
      const timestamp = timestampMs(row[0]);
      if (timestamp < input.startTime || timestamp > input.endTime) continue;
      output.set(timestamp, { timestamp, open: positive(row[1], "open"), high: positive(row[2], "high"), low: positive(row[3], "low"), close: positive(row[4], "close") });
    }
    if (!rows.length) break;
    const earliest = Math.min(...rows.map((row) => timestampMs(row[0])));
    if (earliest <= input.startTime || earliest >= end) break;
    end = earliest - 1;
  }
  return [...output.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function positive(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid ticker ${label}`);
  return number;
}
function positiveOr(value: unknown, fallback: number) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function finiteOrNull(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : null; }
