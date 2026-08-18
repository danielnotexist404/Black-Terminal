import type { Candle } from "../../../chart-engine/types.ts";
import { ddaProCalculationSettingsHash, resolveDDAProBarsPerYear } from "./settings.ts";
import { mean, populationDeviation, quantile } from "./statistics.ts";
import type {
  DDAProCalculationInput,
  DDAProEpisode,
  DDAProEvent,
  DDAProLatestMetrics,
  DDAProRiskState,
  DDAProSignalEvent,
  DDAProSeries,
  DDAProSettings
} from "./types.ts";
import { DDA_PRO_INDICATOR_ID } from "./types.ts";

export function blankSeries(length: number): DDAProSeries {
  const series = () => new Array<number>(length).fill(0);
  return {
    rawDrawdown: series(), smoothedDrawdown: series(), depth: series(), mean: series(),
    sigmaUpper: series(), sigmaLower: series(), p05: series(), p10: series(), p25: series(),
    p50: series(), p75: series(), p90: series(), p95: series(), p99: series(), percentileRank: series(),
    zScore: series(), duration: series(), timeUnderWater: series(), recoveryProgress: series(),
    velocity: series(), acceleration: series(), vadd: series(), riskScore: series(),
    riskState: new Array(length).fill("INSUFFICIENT")
  };
}

export function sourceValues(input: DDAProCalculationInput) {
  const { settings, candles } = input;
  if (settings.equitySource !== "price") {
    const equity = input.equityValues;
    if (equity?.length === candles.length && equity.every((value) => Number.isFinite(value) && value > 0)) {
      return {
        values: [...equity],
        authority: settings.equitySource === "connected-account" ? "ACCOUNT_EQUITY" as const : "STRATEGY_EQUITY" as const,
        warning: null
      };
    }
    return {
      values: [] as number[],
      authority: "UNAVAILABLE" as const,
      warning: `${settings.equitySource.replaceAll("-", " ")} is unavailable. Price data was not substituted for the requested equity series.`
    };
  }
  return {
    values: candles.map((candle) => settings.source === "hlc3"
      ? (candle.high + candle.low + candle.close) / 3
      : settings.source === "ohlc4"
        ? (candle.open + candle.high + candle.low + candle.close) / 4
        : candle.close),
    authority: "MARKET_PRICE" as const,
    warning: null
  };
}

export function finiteMetric(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function buildEpisodes(candles: readonly Candle[], depth: readonly number[], threshold: number) {
  const episodes: DDAProEpisode[] = [];
  const recoveryThreshold = Math.max(1e-9, threshold * 0.05);
  let active: DDAProEpisode | null = null;
  for (let index = 0; index < depth.length; index++) {
    const value = depth[index] ?? 0;
    if (!active && value >= threshold && value > 0) {
      active = {
        id: `dda-episode-${candles[index]?.time ?? index}`,
        startIndex: index,
        troughIndex: index,
        recoveryIndex: null,
        depthPercent: value,
        durationBars: 1,
        recoveryBars: null,
        areaUnderWater: value,
        recovered: false
      };
      continue;
    }
    if (!active) continue;
    active.durationBars = index - active.startIndex + 1;
    active.areaUnderWater += value;
    if (value > active.depthPercent) {
      active.depthPercent = value;
      active.troughIndex = index;
    }
    if (value < recoveryThreshold) {
      active.recoveryIndex = index;
      active.recoveryBars = index - active.troughIndex;
      active.recovered = true;
      episodes.push(active);
      active = null;
    }
  }
  if (active) episodes.push(active);
  return episodes;
}

export function deriveEvents(
  candles: readonly Candle[],
  riskStates: readonly DDAProRiskState[],
  depth: readonly number[],
  episodes: readonly DDAProEpisode[]
) {
  const events: DDAProEvent[] = [];
  let prior: DDAProRiskState = "INSUFFICIENT";
  let maximum = 0;
  for (let index = 0; index < candles.length; index++) {
    const state = riskStates[index] ?? "INSUFFICIENT";
    if (state !== prior && state !== "INSUFFICIENT") {
      events.push({ id: `dda-state-${candles[index]?.time ?? index}`, type: "DDA_RISK_STATE_CHANGED", index, time: candles[index]?.time ?? 0, state, value: depth[index] ?? 0 });
    }
    prior = state;
    if ((depth[index] ?? 0) > maximum) {
      maximum = depth[index] ?? 0;
      events.push({ id: `dda-extreme-${candles[index]?.time ?? index}`, type: "DDA_NEW_MAX_DRAWDOWN", index, time: candles[index]?.time ?? 0, state, value: maximum });
    }
  }
  for (const episode of episodes) {
    const start = candles[episode.startIndex];
    events.push({ id: "dda-start-" + (start?.time ?? episode.startIndex), type: "DDA_DRAWDOWN_STARTED", index: episode.startIndex, time: start?.time ?? 0, state: riskStates[episode.startIndex] ?? "INSUFFICIENT", value: depth[episode.startIndex] ?? 0 });
    if (episode.troughIndex > episode.startIndex) {
      const trough = candles[episode.troughIndex];
      events.push({ id: "dda-deepened-" + (trough?.time ?? episode.troughIndex), type: "DDA_DRAWDOWN_DEEPENED", index: episode.troughIndex, time: trough?.time ?? 0, state: riskStates[episode.troughIndex] ?? "INSUFFICIENT", value: episode.depthPercent });
    }
    if (episode.recoveryIndex === null) continue;
    const recoveringIndex = Math.min(episode.recoveryIndex, episode.troughIndex + 1);
    const recovering = candles[recoveringIndex];
    events.push({ id: "dda-recovering-" + (recovering?.time ?? recoveringIndex), type: "DDA_DRAWDOWN_RECOVERING", index: recoveringIndex, time: recovering?.time ?? 0, state: riskStates[recoveringIndex] ?? "INSUFFICIENT", value: depth[recoveringIndex] ?? 0 });
    const candle = candles[episode.recoveryIndex];
    events.push({ id: "dda-recovery-" + (candle?.time ?? episode.recoveryIndex), type: "DDA_DRAWDOWN_RECOVERED", index: episode.recoveryIndex, time: candle?.time ?? 0, state: "LOW", value: episode.depthPercent });
  }
  return events;
}

export function deriveDDAProSignals(events: readonly DDAProEvent[]): DDAProSignalEvent[] {
  const signals: DDAProSignalEvent[] = [];
  for (const event of events) {
    if (event.type === "DDA_DRAWDOWN_DEEPENED") signals.push({
      id: `bc-rda-long-${event.time || event.index}`, indicatorId: DDA_PRO_INDICATOR_ID,
      direction: "long" as const, index: event.index, time: event.time, value: event.value,
      sourceEventType: event.type, markerTone: "silver-white" as const
    });
    if (event.type === "DDA_DRAWDOWN_RECOVERED") signals.push({
      id: `bc-rda-short-${event.time || event.index}`, indicatorId: DDA_PRO_INDICATOR_ID,
      direction: "short" as const, index: event.index, time: event.time, value: event.value,
      sourceEventType: event.type, markerTone: "blood-red" as const
    });
  }
  return signals;
}

export function latestConfirmedDDAProCandleTime(
  candles: readonly Pick<Candle, "time">[],
  timeframeSeconds: number,
  nowSeconds: number
) {
  const duration = Math.max(1, Number(timeframeSeconds) || 1);
  let latest = 0;
  for (const candle of candles) {
    const time = Number(candle.time);
    if (Number.isFinite(time) && time > latest && time + duration <= nowSeconds) latest = time;
  }
  return latest;
}

export function confirmedNewestDDAProSignals(
  signals: readonly DDAProSignalEvent[],
  inputSize: number,
  timeframeSeconds: number,
  nowSeconds: number,
  armedAfterTime: number
) {
  const latestIndex = Math.max(0, inputSize - 1);
  const duration = Math.max(1, Number(timeframeSeconds) || 1);
  return signals.filter((signal) =>
    signal.index === latestIndex &&
    signal.time > armedAfterTime &&
    signal.time + duration <= nowSeconds
  );
}

export function performanceMetrics(
  values: readonly number[],
  depth: readonly number[],
  settings: DDAProSettings,
  timeframeSeconds: number,
  dar95: number,
  cdar95: number
) {
  const returns = values.slice(1).map((value, index) => value > 0 && (values[index] ?? 0) > 0 ? Math.log(value / (values[index] ?? value)) : 0);
  const barsPerYear = settings.engineMode === "pine-compatibility" ? 252 : resolveDDAProBarsPerYear(settings, timeframeSeconds);
  const averageReturn = mean(returns);
  const riskFreeBar = Math.log1p(settings.riskFreeRatePercent / 100) / Math.max(1, barsPerYear);
  const averageExcessReturn = averageReturn - riskFreeBar;
  const volatility = populationDeviation(returns, averageReturn);
  const downside = returns.map((value) => Math.min(0, value - (settings.engineMode === "pine-compatibility" ? 0 : riskFreeBar)));
  const downsideDeviation = Math.sqrt(mean(downside.map((value) => value * value)));
  const annualizedReturn = settings.engineMode === "pine-compatibility"
    ? averageReturn * barsPerYear * 100
    : Math.expm1(averageReturn * barsPerYear) * 100;
  const annualizedVolatility = volatility * Math.sqrt(barsPerYear) * 100;
  const excess = annualizedReturn - settings.riskFreeRatePercent;
  const maxDepth = Math.max(...depth, 0);
  const sortedReturns = [...returns].sort((left, right) => left - right);
  const returnVaR = Math.max(0, -quantile(sortedReturns, 0.05, settings.quantileMethod) * 100);
  const tail = sortedReturns.filter((value) => value <= -returnVaR / 100);
  const returnES = Math.max(0, -mean(tail) * 100);
  const ulcer = Math.sqrt(mean(depth.map((value) => value * value)));
  const pain = mean(depth);
  const omegaThreshold = settings.engineMode === "pine-compatibility" ? 0 : riskFreeBar;
  const grossGains = returns.reduce((sum, value) => sum + Math.max(0, value - omegaThreshold), 0);
  const grossLosses = returns.reduce((sum, value) => sum + Math.max(0, omegaThreshold - value), 0);
  const netReturn = values.length > 1 && (values[0] ?? 0) > 0 ? ((values.at(-1) ?? 0) / (values[0] ?? 1) - 1) * 100 : 0;
  return {
    barsPerYear,
    annualizedReturnPercent: finiteMetric(annualizedReturn),
    annualizedVolatilityPercent: finiteMetric(annualizedVolatility),
    sharpe: volatility > 1e-12 ? finiteMetric(settings.engineMode === "pine-compatibility" ? excess / annualizedVolatility : averageExcessReturn / volatility * Math.sqrt(barsPerYear)) : 0,
    sortino: downsideDeviation > 1e-12 ? finiteMetric(settings.engineMode === "pine-compatibility" ? excess / (downsideDeviation * Math.sqrt(barsPerYear) * 100) : averageExcessReturn / downsideDeviation * Math.sqrt(barsPerYear)) : 0,
    calmar: maxDepth > 1e-12 ? finiteMetric(annualizedReturn / maxDepth) : 0,
    returnVaR95Percent: finiteMetric(returnVaR),
    returnES95Percent: finiteMetric(returnES),
    drawdownAtRisk95Percent: finiteMetric(dar95),
    conditionalDrawdownAtRisk95Percent: finiteMetric(cdar95),
    ulcerIndex: finiteMetric(ulcer),
    painIndex: finiteMetric(pain),
    recoveryFactor: maxDepth > 1e-12 ? finiteMetric(netReturn / maxDepth) : 0,
    omegaRatio: grossLosses > 1e-12 ? finiteMetric(grossGains / grossLosses) : 0
  };
}

function fnv1aHasher(prefix: string) {
  let hash = 0x811c9dc5;
  const numericBuffer = new ArrayBuffer(8);
  const numericView = new DataView(numericBuffer);
  const numericBytes = new Uint8Array(numericBuffer);
  const updateByte = (value: number) => {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const updateString = (value: string) => {
    for (let index = 0; index < value.length; index++) updateByte(value.charCodeAt(index));
  };
  const updateNumber = (value: number) => {
    if (!Number.isFinite(value)) {
      updateByte(0);
      return;
    }
    updateByte(1);
    numericView.setFloat64(0, value, true);
    for (const byte of numericBytes) updateByte(byte);
  };
  updateString(prefix);
  return {
    updateString,
    updateNumber,
    digest: () => "fnv1a-" + hash.toString(16).padStart(8, "0")
  };
}

function fnv1aHash(prefix: string, feed: (update: (value: string) => void) => void) {
  const hasher = fnv1aHasher(prefix);
  feed(hasher.updateString);
  return hasher.digest();
}

export function ddaProDataHash(input: DDAProCalculationInput) {
  const hasher = fnv1aHasher("dda-data-v2|");
  hasher.updateNumber(input.candles.length);
  for (const candle of input.candles) {
    hasher.updateNumber(candle.time);
    hasher.updateNumber(candle.open);
    hasher.updateNumber(candle.high);
    hasher.updateNumber(candle.low);
    hasher.updateNumber(candle.close);
  }
  if (input.equityValues) {
    hasher.updateString("equity|");
    hasher.updateNumber(input.equityValues.length);
    for (const value of input.equityValues) hasher.updateNumber(value);
  }
  return hasher.digest();
}

export function ddaProOutputHash(series: DDAProSeries, latest: DDAProLatestMetrics) {
  const hasher = fnv1aHasher("dda-output-v2|");
  for (const key of Object.keys(series).sort() as Array<keyof DDAProSeries>) {
    hasher.updateString(key + "|");
    for (const value of series[key]) {
      if (typeof value === "number") hasher.updateNumber(value);
      else hasher.updateString(value + "|");
    }
  }
  for (const key of Object.keys(latest).sort() as Array<keyof DDAProLatestMetrics>) {
    hasher.updateString(key + "=");
    const value = latest[key];
    if (typeof value === "number") hasher.updateNumber(value);
    else hasher.updateString(value);
  }
  return hasher.digest();
}

export function calculationHash(input: DDAProCalculationInput, engine: string, dataHash = ddaProDataHash(input)) {
  return fnv1aHash("dda-calculation-v1|", (update) => update(engine + "|" + ddaProCalculationSettingsHash(input.settings) + "|" + dataHash));
}

export function latestFromSeries(
  series: DDAProSeries,
  state: DDAProRiskState,
  confidence: number,
  metrics: ReturnType<typeof performanceMetrics>,
  maxDepthPercent = Math.max(...series.depth, 0)
): DDAProLatestMetrics {
  const index = Math.max(0, series.depth.length - 1);
  return {
    drawdownPercent: finiteMetric(series.rawDrawdown[index] ?? 0),
    depthPercent: finiteMetric(series.depth[index] ?? 0),
    maxDrawdownPercent: finiteMetric(maxDepthPercent),
    percentileRank: finiteMetric(series.percentileRank[index] ?? 0),
    zScore: finiteMetric(series.zScore[index] ?? 0),
    riskState: state,
    riskScore: finiteMetric(series.riskScore[index] ?? 0),
    confidence: finiteMetric(confidence),
    durationBars: finiteMetric(series.duration[index] ?? 0),
    timeUnderWaterBars: finiteMetric(series.timeUnderWater[index] ?? 0),
    recoveryProgressPercent: finiteMetric(series.recoveryProgress[index] ?? 0),
    velocity: finiteMetric(series.velocity[index] ?? 0),
    acceleration: finiteMetric(series.acceleration[index] ?? 0),
    ...metrics,
    vadd: finiteMetric(series.vadd[index] ?? 0)
  };
}
