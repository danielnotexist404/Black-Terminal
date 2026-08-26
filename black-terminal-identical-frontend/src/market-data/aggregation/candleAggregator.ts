import type { Candle } from "../../chart-engine/types";
import type { Timeframe, TradeTick } from "../types";

export const timeframeSeconds: Partial<Record<Timeframe, number>> = {
  "1s": 1,
  "10s": 10,
  "30s": 30,
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "3h": 10800,
  "4h": 14400,
  "6h": 21600,
  "8h": 28800,
  "12h": 43200,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000
};

const timeframeTrades: Partial<Record<Timeframe, number>> = {
  "1t": 1,
  "10t": 10,
  "100t": 100
};

type TickBucket = {
  candle: Candle;
  count: number;
};

export function isTickTimeframe(timeframe: Timeframe) {
  return timeframeTrades[timeframe] !== undefined;
}

export function isSubMinuteTimeframe(timeframe: Timeframe) {
  return timeframe === "1s" || timeframe === "10s" || timeframe === "30s";
}

export function isTradeBuiltTimeframe(timeframe: Timeframe) {
  return isSubMinuteTimeframe(timeframe) || isTickTimeframe(timeframe);
}

export function requiresTradeSynthesis(timeframe: Timeframe) {
  return isTradeBuiltTimeframe(timeframe) || timeframe === "3h";
}

export function baseTimeframeForDerived(timeframe: Timeframe): Timeframe | undefined {
  return timeframe === "3h" ? "1h" : undefined;
}

export function derivedTimeframeFactor(timeframe: Timeframe) {
  const base = baseTimeframeForDerived(timeframe);
  const targetSeconds = timeframeSeconds[timeframe];
  const baseSeconds = base ? timeframeSeconds[base] : undefined;
  return targetSeconds && baseSeconds ? targetSeconds / baseSeconds : 1;
}

export class CandleAggregationEngine {
  private buckets = new Map<string, Candle>();
  private tickBuckets = new Map<string, TickBucket>();

  ingestTrade(trade: TradeTick, timeframe: Timeframe): { candle: Candle; closed?: Candle } | null {
    const tradesPerCandle = timeframeTrades[timeframe];
    if (tradesPerCandle) return this.ingestTickCandle(trade, timeframe, tradesPerCandle);

    const seconds = timeframeSeconds[timeframe];
    if (!seconds) return null;

    const tradeTime = normalizeEpochSeconds(trade.time);
    const bucketTime = Math.floor(tradeTime / seconds) * seconds;
    const key = `${trade.exchange}:${trade.symbol}:${timeframe}`;
    const current = this.buckets.get(key);

    if (!current || current.time !== bucketTime) {
      const candle: Candle = {
        time: bucketTime,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.quantity
      };
      this.buckets.set(key, candle);
      return { candle, closed: current };
    }

    const next: Candle = {
      ...current,
      high: Math.max(current.high, trade.price),
      low: Math.min(current.low, trade.price),
      close: trade.price,
      volume: current.volume + trade.quantity
    };
    this.buckets.set(key, next);
    return { candle: next };
  }

  private ingestTickCandle(
    trade: TradeTick,
    timeframe: Timeframe,
    tradesPerCandle: number
  ): { candle: Candle; closed?: Candle } {
    const key = `${trade.exchange}:${trade.symbol}:${timeframe}`;
    const current = this.tickBuckets.get(key);
    if (!current || current.count >= tradesPerCandle) {
      const rawTime = normalizeEpochSeconds(trade.time);
      const candleTime = current ? Math.max(rawTime, current.candle.time + 0.000001) : rawTime;
      const candle: Candle = {
        time: candleTime,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.quantity
      };
      this.tickBuckets.set(key, { candle, count: 1 });
      return { candle, closed: current?.candle };
    }

    const candle: Candle = {
      ...current.candle,
      high: Math.max(current.candle.high, trade.price),
      low: Math.min(current.candle.low, trade.price),
      close: trade.price,
      volume: current.candle.volume + trade.quantity
    };
    this.tickBuckets.set(key, { candle, count: current.count + 1 });
    return { candle };
  }
}

export function buildCandlesFromTrades(
  trades: readonly TradeTick[],
  timeframe: Timeframe,
  engine = new CandleAggregationEngine()
) {
  const candles = new Map<number, Candle>();
  const seen = new Set<string>();
  const ordered = [...trades].sort((left, right) =>
    normalizeEpochSeconds(left.time) - normalizeEpochSeconds(right.time)
    || left.tradeId.localeCompare(right.tradeId)
  );
  for (const trade of ordered) {
    const identity = `${trade.exchange}:${trade.symbol}:${trade.tradeId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const result = engine.ingestTrade(trade, timeframe);
    if (!result) continue;
    if (result.closed) candles.set(result.closed.time, result.closed);
    candles.set(result.candle.time, result.candle);
  }
  return [...candles.values()].sort((left, right) => left.time - right.time);
}

export function aggregateCandlesToTimeframe(candles: readonly Candle[], timeframe: Timeframe) {
  const seconds = timeframeSeconds[timeframe];
  if (!seconds || isTickTimeframe(timeframe)) return [];
  const buckets = new Map<number, Candle>();
  for (const candle of [...candles].sort((left, right) => left.time - right.time)) {
    const bucketTime = Math.floor(candle.time / seconds) * seconds;
    const current = buckets.get(bucketTime);
    buckets.set(bucketTime, current ? {
      ...current,
      high: Math.max(current.high, candle.high),
      low: Math.min(current.low, candle.low),
      close: candle.close,
      volume: current.volume + candle.volume
    } : { ...candle, time: bucketTime });
  }
  return [...buckets.values()].sort((left, right) => left.time - right.time);
}

function normalizeEpochSeconds(value: number) {
  return value > 100_000_000_000 ? value / 1000 : value;
}
