import type { Candle } from "../../../chart-engine/types";
import { robustZ } from "../core/statistics.ts";
import {
  BC_TERA_FEATURE_SCHEMA_VERSION,
  type BCTERADataProfile,
  type BCTERADecisionTimeframe,
  type BCTERAFeatureBar,
  type BCTERASourceObservation
} from "../core/types.ts";

const TIMEFRAME_SECONDS: Record<BCTERADecisionTimeframe, number> = {
  "4H": 4 * 60 * 60,
  "12H": 12 * 60 * 60,
  "1D": 24 * 60 * 60,
  "3D": 3 * 24 * 60 * 60,
  "1W": 7 * 24 * 60 * 60
};

type ChartFeatureContext = {
  symbol: string;
  venue: string;
  profile?: BCTERADataProfile;
  timeframe: BCTERADecisionTimeframe;
  confirmedCutoff: number;
  receivedTimestamp?: number;
  revisionId?: string;
  maximumBars?: number;
};

type Aggregate = Candle & { start: number };

export function buildChartFeatureBars(candles: readonly Candle[], context: ChartFeatureContext): BCTERAFeatureBar[] {
  const timeframeSeconds = TIMEFRAME_SECONDS[context.timeframe];
  const aggregates = new Map<number, Aggregate>();
  const canonicalCandles = new Map<number, Candle>();
  for (const candle of candles) {
    if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) continue;
    canonicalCandles.set(candle.time, candle);
  }
  for (const candle of [...canonicalCandles.values()].sort((left, right) => left.time - right.time)) {
    const start = Math.floor(candle.time / timeframeSeconds) * timeframeSeconds;
    const current = aggregates.get(start);
    if (!current) {
      aggregates.set(start, { ...candle, time: start, start });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }
  const ordered = [...aggregates.values()].sort((left, right) => left.time - right.time)
    .slice(-Math.max(30, Math.min(2000, context.maximumBars ?? 600)));
  const closes: number[] = [];
  const returns: number[] = [];
  return ordered.map((bar, index) => {
    const previousClose = index > 0 ? ordered[index - 1]!.close : bar.close;
    const logReturn = previousClose > 0 && bar.close > 0 ? Math.log(bar.close / previousClose) : 0;
    closes.push(bar.close);
    returns.push(logReturn);
    const causalCloses = closes.slice(Math.max(0, closes.length - 90));
    const causalReturns = returns.slice(Math.max(0, returns.length - 30));
    const mean = causalCloses.reduce((sum, value) => sum + value, 0) / Math.max(1, causalCloses.length);
    const volatility = Math.sqrt(causalReturns.reduce((sum, value) => sum + value * value, 0) / Math.max(1, causalReturns.length));
    const trend = Math.tanh(robustZ(bar.close, causalCloses) / 2);
    const distanceFromMean = mean > 0 ? Math.tanh(((bar.close / mean) - 1) / Math.max(0.01, volatility * 3)) : 0;
    const priorWindow = ordered.slice(Math.max(0, index - 20), index);
    const priorHigh = priorWindow.length ? Math.max(...priorWindow.map((item) => item.high)) : Infinity;
    const priorLow = priorWindow.length ? Math.min(...priorWindow.map((item) => item.low)) : -Infinity;
    const confirmed = bar.time + timeframeSeconds <= context.confirmedCutoff;
    const sourceCutoff = Math.min(context.confirmedCutoff, bar.time + timeframeSeconds);
    const source: BCTERASourceObservation = {
      source: "black-terminal-chart-candles",
      venue: context.venue,
      symbol: context.symbol,
      marketType: "SPOT",
      eventTimestamp: bar.time,
      sourceCutoff,
      receivedTimestamp: context.receivedTimestamp ?? context.confirmedCutoff,
      sequence: null,
      revisionId: context.revisionId ?? `chart-${context.symbol}-${sourceCutoff}`,
      quality: "VERIFIED_PARTIAL"
    };
    return {
      schemaVersion: BC_TERA_FEATURE_SCHEMA_VERSION,
      symbol: context.symbol,
      exchangeScope: context.venue,
      profile: context.profile ?? "SPOT_ONLY",
      timeframe: context.timeframe,
      time: bar.time,
      confirmed,
      sourceCutoff,
      receivedTimestamp: source.receivedTimestamp,
      revisionId: source.revisionId,
      market: {
        quality: "VERIFIED_PARTIAL",
        sources: [source],
        values: {
          close: bar.close,
          logReturn,
          realizedVolatility: volatility,
          trend,
          distanceFromMean,
          structureBreakUp: confirmed && bar.close > priorHigh,
          structureBreakDown: confirmed && bar.close < priorLow
        }
      },
      valuation: null,
      spotFlow: null,
      orderBook: null,
      derivatives: null,
      liquidations: null,
      options: null,
      stablecoinLiquidity: null,
      unavailable: [
        "VALUATION", "SPOT_FLOW", "ORDER_BOOK", "DERIVATIVES",
        "LIQUIDATIONS", "OPTIONS", "STABLECOIN_LIQUIDITY"
      ]
    };
  });
}
