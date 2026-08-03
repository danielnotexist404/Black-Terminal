import type { Candle } from "../../../chart-engine/types.ts";
import type { CanonicalTrade, ProfileDataQuality } from "../core/types.ts";

export function calculateProfileDataQuality(
  start: number,
  end: number,
  bars: readonly Candle[],
  lowerBars: readonly Candle[],
  trades: readonly CanonicalTrade[]
): ProfileDataQuality {
  const exactTimes = trades
    .filter(trade => trade.source === "EXCHANGE_AGGRESSOR_FLAG" || trade.source === "MAKER_SIDE_INVERSION")
    .map(trade => trade.timestamp)
    .sort((left, right) => left - right);
  const lowerTimes = lowerBars.map(bar => bar.time).sort((left, right) => left - right);
  const coveredBars = (times: readonly number[], excluded = new Set<number>()) => {
    const covered = new Set<number>();
    let cursor = 0;
    for (let index = 0; index < bars.length; index += 1) {
      const barStart = bars[index]!.time;
      const interval = bars[index + 1]?.time ?? barStart + Math.max(1, barStart - (bars[index - 1]?.time ?? barStart - 1));
      while (cursor < times.length && times[cursor]! < barStart) cursor += 1;
      if (!excluded.has(index) && cursor < times.length && times[cursor]! < interval) covered.add(index);
    }
    return covered;
  };
  const exactBars = coveredBars(exactTimes);
  const lowerCoveredBars = coveredBars(lowerTimes, exactBars);
  const denominator = Math.max(1, bars.length);
  const exactTradeCoveragePercent = exactBars.size / denominator * 100;
  const lowerTimeframeCoveragePercent = lowerCoveredBars.size / denominator * 100;
  const chartBarCoveragePercent = bars.length
    ? Math.max(0, 100 - exactTradeCoveragePercent - lowerTimeframeCoveragePercent)
    : 0;
  const totalQuantity = trades.reduce((sum, trade) => sum + trade.quantity, 0);
  const unknownQuantity = trades.reduce((sum, trade) => sum + (trade.aggressorSide === "UNKNOWN" ? trade.quantity : 0), 0);
  const sourceMix: ProfileDataQuality["sourceMix"] = [];
  if (trades.length) sourceMix.push("LIVE_TRADE_STREAM");
  if (lowerBars.length) sourceMix.push("LOWER_TIMEFRAME_BARS");
  if (bars.length) sourceMix.push("CHART_BARS");
  const covered = exactTradeCoveragePercent + lowerTimeframeCoveragePercent + chartBarCoveragePercent;
  return {
    requestedStart: start,
    requestedEnd: end,
    exactTradeCoveragePercent,
    lowerTimeframeCoveragePercent,
    chartBarCoveragePercent,
    unknownAggressorPercent: totalQuantity > 0 ? unknownQuantity / totalQuantity * 100 : 0,
    missingIntervals: covered < 99.9 ? [{ start, end }] : [],
    quality: exactTradeCoveragePercent >= 99 ? "EXACT" : exactTradeCoveragePercent >= 80 ? "HIGH" : exactTradeCoveragePercent > 0 ? "MIXED" : bars.length || lowerBars.length ? "APPROXIMATE" : "INSUFFICIENT",
    sourceMix
  };
}
