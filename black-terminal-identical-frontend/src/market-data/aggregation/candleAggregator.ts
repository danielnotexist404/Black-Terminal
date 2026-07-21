import type { Candle } from "../../chart-engine/types";
import type { Timeframe, TradeTick } from "../types";

const timeframeSeconds: Partial<Record<Timeframe, number>> = {
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
  "4h": 14400,
  "12h": 43200,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000
};

export class CandleAggregationEngine {
  private buckets = new Map<string, Candle>();

  ingestTrade(trade: TradeTick, timeframe: Timeframe): { candle: Candle; closed?: Candle } | null {
    const seconds = timeframeSeconds[timeframe];
    if (!seconds) return null;

    const bucketTime = Math.floor(trade.time / 1000 / seconds) * seconds;
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
}
