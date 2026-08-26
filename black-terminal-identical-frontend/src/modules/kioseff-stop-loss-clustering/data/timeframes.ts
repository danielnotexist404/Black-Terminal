import type { Timeframe } from "../../../market-data/types";
import { KioseffDataUnavailableError } from "./types.ts";

const SECONDS: Partial<Record<Timeframe, number>> = {
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
  "1w": 604800
};

export function kioseffTimeframeSeconds(timeframe: Timeframe) {
  const seconds = SECONDS[timeframe];
  if (!seconds) {
    throw new KioseffDataUnavailableError("invalid-time-bucketing", { timeframe });
  }
  return seconds;
}

export function validateLowerTimeframe(chartTimeframe: Timeframe, lowerTimeframe: Timeframe) {
  const chartSeconds = kioseffTimeframeSeconds(chartTimeframe);
  const lowerSeconds = kioseffTimeframeSeconds(lowerTimeframe);
  if (lowerSeconds > chartSeconds || chartSeconds % lowerSeconds !== 0) {
    throw new KioseffDataUnavailableError("unsupported-lower-timeframe", {
      chartTimeframe,
      lowerTimeframe
    });
  }
  return { chartSeconds, lowerSeconds };
}

export function utcBucketStart(time: number, timeframe: Timeframe) {
  const seconds = kioseffTimeframeSeconds(timeframe);
  return Math.floor(time / seconds) * seconds;
}
