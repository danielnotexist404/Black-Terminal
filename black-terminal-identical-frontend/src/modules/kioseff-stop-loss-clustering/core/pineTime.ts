import type { Timeframe } from "../../../market-data/types";
import { kioseffTimeframeSeconds } from "../data/timeframes.ts";

export function pineTimeframeSeconds(timeframe: Timeframe) {
  return kioseffTimeframeSeconds(timeframe);
}

export function pineTimeframeDayChange(currentTime: number, previousTime: number | undefined) {
  if (previousTime === undefined) return false;
  return Math.floor(currentTime / 86_400) !== Math.floor(previousTime / 86_400);
}

export function pineTimestampIndex(times: readonly number[], target: number) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (times[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function pineBarDistance(options: {
  assetClass: string;
  currentTime: number;
  pivotTime: number;
  chartBarMilliseconds: number;
  currentBarIndex: number;
  barTimes: readonly number[];
}) {
  if (options.assetClass === "crypto") {
    return Math.round(
      (options.currentTime - options.pivotTime) / options.chartBarMilliseconds
    );
  }
  return options.currentBarIndex - pineTimestampIndex(options.barTimes, options.pivotTime);
}

