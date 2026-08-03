import type { Candle } from "../../../chart-engine/types.ts";
import { auctionProfileLookbackWarnings } from "../core/settings.ts";
import { appendTradesToAuctionMatrix, buildAuctionBlockMatrix } from "../core/blockMatrix.ts";
import { auctionProfileVersion, stableHash } from "../core/canonical.ts";
import { detectAuctionNodes } from "../core/nodes.ts";
import { auctionRowIndex, createAuctionProfileGrid } from "../core/profileGrid.ts";
import { resolveAuctionScopeWindows, scopeBars } from "../core/scope.ts";
import { AUCTION_PROFILE_ENGINE_VERSION } from "../core/types.ts";
import type {
  AuctionOffChartPoint,
  AuctionProfileCalculationInput,
  AuctionProfileRow,
  AuctionProfileSnapshot,
  AuctionScopeWindow,
  CanonicalTrade
} from "../core/types.ts";
import { calculateAuctionKeyLevels } from "../core/valueArea.ts";
import { calculateProfileDataQuality } from "../data/coverage.ts";
import { estimateBarDelta } from "../data/fallback.ts";
import { activityMetricValue, liquidityWeightedActivity } from "./activity.ts";
import { cvdMetricValue } from "./cvd.ts";
import { applyHybridScores } from "./hybrid.ts";
import { parkinsonMetricValue, parkinsonVariance } from "./parkinson.ts";
import { applyPineCompatibleBars, PINE_CVD_PROFILE_KNOWN_ANOMALIES } from "./pineCompatibility.ts";
import { tpoMetricValue } from "./tpo.ts";
import { garmanKlassMetricValue, garmanKlassVariance, realizedVariance, volatilityMetricValue } from "./volatility.ts";
import { volumeMetricValue } from "./volume.ts";
import { usdVolumeMetricValue } from "./usdVolume.ts";

function emptyRows(origin: number, rowSize: number, count: number): AuctionProfileRow[] {
  return Array.from({ length: count }, (_, index) => {
    const low = origin + index * rowSize;
    return {
      index,
      low,
      high: low + rowSize,
      center: low + rowSize / 2,
      value: 0,
      buyQuantity: 0,
      sellQuantity: 0,
      unknownQuantity: 0,
      totalQuantity: 0,
      buyNotional: 0,
      sellNotional: 0,
      unknownNotional: 0,
      tradeCount: 0,
      averageTradeSize: 0,
      maximumTradeSize: 0,
      tpoCount: 0,
      realizedVariance: 0,
      parkinsonVariance: 0,
      garmanKlassVariance: 0,
      rangeExpansion: 0,
      cvdEfficiency: 0,
      cvdPersistence: 0,
      hybridScore: 0,
      inValueArea: false
    };
  });
}

function barIndexForTime(bars: readonly Candle[], time: number) {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle]!.time <= time) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(bars.length - 1, high));
}

function allocationWeights(bar: Candle, start: number, end: number, rows: readonly AuctionProfileRow[], mode: string) {
  const weights: number[] = [];
  const typical = (bar.high + bar.low + bar.close) / 3;
  for (let index = start; index <= end; index += 1) {
    const center = rows[index]!.center;
    let weight = 1;
    if (mode === "CLOSE_WEIGHTED") weight = 1 / (1 + Math.abs(center - bar.close) / Math.max(rows[index]!.high - rows[index]!.low, Number.EPSILON));
    if (mode === "TYPICAL_PRICE_WEIGHTED") weight = 1 / (1 + Math.abs(center - typical) / Math.max(rows[index]!.high - rows[index]!.low, Number.EPSILON));
    if (mode === "GAUSSIAN_AROUND_VWAP") {
      const sigma = Math.max((bar.high - bar.low) / 4, Number.EPSILON);
      weight = Math.exp(-0.5 * ((center - typical) / sigma) ** 2);
    }
    if (mode === "BODY_WICK_WEIGHTED" || mode === "HYBRID") {
      const bodyLow = Math.min(bar.open, bar.close);
      const bodyHigh = Math.max(bar.open, bar.close);
      weight = center >= bodyLow && center <= bodyHigh ? 2.5 : 0.65;
      if (mode === "HYBRID") weight *= 1 / (1 + Math.abs(center - typical) / Math.max(bar.high - bar.low, Number.EPSILON));
    }
    weights.push(weight);
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  return weights.map(weight => weight / total);
}

function allocateBar(
  rows: AuctionProfileRow[],
  grid: Parameters<typeof auctionRowIndex>[0],
  bar: Candle,
  previousClose: number | undefined,
  mode: string,
  tpoSets: Array<Set<number>>,
  bracketSeconds: number,
  exactSide?: { buy: number; sell: number; unknown: number }
) {
  const start = auctionRowIndex(grid, bar.low);
  const end = auctionRowIndex(grid, bar.high);
  const weights = allocationWeights(bar, start, end, rows, mode);
  const estimated = exactSide ?? estimateBarDelta(bar);
  const buyQuantity = "buy" in estimated ? estimated.buy : estimated.buyQuantity;
  const sellQuantity = "sell" in estimated ? estimated.sell : estimated.sellQuantity;
  const unknownQuantity = "unknown" in estimated ? estimated.unknown : estimated.unknownQuantity;
  const rv = realizedVariance(bar, previousClose);
  const pv = parkinsonVariance(bar);
  const gkv = garmanKlassVariance(bar);
  for (let index = start; index <= end; index += 1) {
    const row = rows[index]!;
    const weight = weights[index - start]!;
    const buy = buyQuantity * weight;
    const sell = sellQuantity * weight;
    const unknown = unknownQuantity * weight;
    row.buyQuantity += buy;
    row.sellQuantity += sell;
    row.unknownQuantity += unknown;
    row.totalQuantity += buy + sell + unknown;
    row.buyNotional += buy * row.center;
    row.sellNotional += sell * row.center;
    row.unknownNotional += unknown * row.center;
    row.realizedVariance += rv * weight;
    row.parkinsonVariance += pv * weight;
    row.garmanKlassVariance += gkv * weight;
    row.rangeExpansion += Math.max(0, bar.high - bar.low) * weight;
    tpoSets[index]!.add(Math.floor(bar.time / bracketSeconds));
  }
}

function allocateTrade(rows: AuctionProfileRow[], grid: Parameters<typeof auctionRowIndex>[0], trade: CanonicalTrade) {
  const row = rows[auctionRowIndex(grid, trade.price)]!;
  if (trade.aggressorSide === "BUY") {
    row.buyQuantity += trade.quantity;
    row.buyNotional += trade.notional;
  } else if (trade.aggressorSide === "SELL") {
    row.sellQuantity += trade.quantity;
    row.sellNotional += trade.notional;
  } else {
    row.unknownQuantity += trade.quantity;
    row.unknownNotional += trade.notional;
  }
  row.totalQuantity += trade.quantity;
  row.tradeCount += 1;
  row.maximumTradeSize = Math.max(row.maximumTradeSize, trade.quantity);
}

function annualization(settings: AuctionProfileCalculationInput["settings"]) {
  if (settings.volatilityAnnualization === "NONE") return 1;
  if (settings.volatilityAnnualization === "CUSTOM") return settings.annualizationPeriods;
  return 365;
}

function applySelectedEngine(rows: AuctionProfileRow[], input: AuctionProfileCalculationInput) {
  const engine = input.settings.calculationEngine;
  const annual = annualization(input.settings);
  rows.forEach(row => {
    row.averageTradeSize = row.tradeCount ? row.totalQuantity / row.tradeCount : 0;
    const delta = row.buyQuantity - row.sellQuantity;
    row.cvdEfficiency = delta / Math.max(row.totalQuantity, Number.EPSILON);
    row.cvdPersistence = Math.abs(delta) / Math.max(row.buyQuantity + row.sellQuantity, Number.EPSILON);
    if (engine === "CVD_REAL_TRADES" || engine === "CVD_PINE_COMPATIBLE") row.value = cvdMetricValue(row, input.settings.cvdMetric);
    else if (["VOLUME", "BUY_VOLUME", "SELL_VOLUME", "DELTA_VOLUME", "IMBALANCE_RATIO", "TRADE_COUNT", "AVERAGE_TRADE_SIZE"].includes(engine)) row.value = volumeMetricValue(row, engine);
    else if (engine === "TPO") row.value = tpoMetricValue(row);
    else if (engine === "ACTIVITY") row.value = activityMetricValue(row);
    else if (engine === "USD_VOLUME") row.value = usdVolumeMetricValue(row);
    else if (engine === "REALIZED_VOLATILITY") row.value = volatilityMetricValue(row, annual);
    else if (engine === "PARKINSON_VOLATILITY") row.value = parkinsonMetricValue(row, annual);
    else if (engine === "GARMAN_KLASS_VOLATILITY") row.value = garmanKlassMetricValue(row, annual);
    else if (engine === "RANGE_EXPANSION") row.value = row.rangeExpansion;
    else if (engine === "LIQUIDITY_WEIGHTED_ACTIVITY") row.value = liquidityWeightedActivity(row);
  });
  applyHybridScores(rows, input.settings.hybridWeights);
  if (engine === "HYBRID_AUCTION_SCORE") rows.forEach(row => { row.value = row.hybridScore; });
}

function offChartSeries(bars: readonly Candle[], trades: readonly CanonicalTrade[]): AuctionOffChartPoint[] {
  let previousDelta = 0;
  const points: AuctionOffChartPoint[] = [];
  bars.forEach((bar, index) => {
    const next = bars[index + 1]?.time ?? Number.POSITIVE_INFINITY;
    const inBar = trades.filter(trade => trade.timestamp >= bar.time && trade.timestamp < next);
    const estimated = estimateBarDelta(bar);
    const buy = inBar.length ? inBar.reduce((sum, trade) => sum + (trade.aggressorSide === "BUY" ? trade.quantity : 0), 0) : estimated.buyQuantity;
    const sell = inBar.length ? inBar.reduce((sum, trade) => sum + (trade.aggressorSide === "SELL" ? trade.quantity : 0), 0) : estimated.sellQuantity;
    const delta = buy - sell;
    points.push({
      time: bar.time,
      cvdDelta: delta,
      cvdAcceleration: delta - previousDelta,
      cvdEfficiency: delta / Math.max(buy + sell, Number.EPSILON),
      cvdPersistence: Math.abs(delta) / Math.max(buy + sell, Number.EPSILON),
      imbalance: (buy - sell) / Math.max(buy + sell, Number.EPSILON),
      realizedVolatility: Math.sqrt(realizedVariance(bar, bars[index - 1]?.close)),
      parkinsonVolatility: Math.sqrt(parkinsonVariance(bar))
    });
    previousDelta = delta;
  });
  return points;
}

function buildScope(
  input: AuctionProfileCalculationInput,
  scope: AuctionScopeWindow,
  startedAt: number
): AuctionProfileSnapshot {
  const bars = scopeBars(input.bars, scope);
  const lowerBars = (input.lowerTimeframeBars ?? []).filter(bar => bar.time >= scope.start && bar.time <= scope.end);
  const trades = input.trades.filter(trade => trade.timestamp >= scope.start && trade.timestamp <= scope.end);
  const grid = createAuctionProfileGrid(bars, input.settings, input.metadata);
  const rows = emptyRows(grid.origin, grid.rowSize, grid.rowCount);
  const bracketSeconds = Math.max(60, input.settings.tpoBracketMinutes * 60);
  const tpoSets = rows.map(() => new Set<number>());

  if (input.settings.implementationMode === "PINE_COMPATIBILITY") {
    applyPineCompatibleBars(rows, grid, bars.slice(-1500));
  } else {
    const exactBarIndices = new Set<number>();
    trades.forEach(trade => {
      allocateTrade(rows, grid, trade);
      exactBarIndices.add(barIndexForTime(bars, trade.timestamp));
    });
    const allowFallback = input.settings.dataSource === "HYBRID" || input.settings.dataSource === "LOWER_TIMEFRAME_BARS" || input.settings.dataSource === "CHART_BARS";
    if (allowFallback) {
      const preferredBars = lowerBars.length ? lowerBars : bars;
      preferredBars.forEach((bar, index) => {
        const chartIndex = barIndexForTime(bars, bar.time);
        if (exactBarIndices.has(chartIndex)) return;
        allocateBar(rows, grid, bar, preferredBars[index - 1]?.close, input.settings.priceAllocation, tpoSets, bracketSeconds);
      });
    }
    rows.forEach((row, index) => { row.tpoCount = tpoSets[index]!.size; });
    applySelectedEngine(rows, input);
  }

  const ibEnd = scope.start + input.settings.initialBalanceMinutes * 60;
  const ibBars = bars.filter(bar => bar.time <= ibEnd);
  const initialBalance = ibBars.length ? { high: Math.max(...ibBars.map(bar => bar.high)), low: Math.min(...ibBars.map(bar => bar.low)) } : undefined;
  const dataHash = stableHash({
    bars: bars.map(bar => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]),
    trades: trades.map(trade => [trade.timestamp, trade.tradeId, trade.price, trade.quantity, trade.aggressorSide, trade.source])
  });
  const settingsHash = input.settings.settingsVersion;
  const baseVersion = auctionProfileVersion({ dataHash, settingsHash, grid, range: { start: scope.start, end: scope.end }, engineVersion: AUCTION_PROFILE_ENGINE_VERSION });
  const nodes = detectAuctionNodes(rows, input.settings, input.now ?? Date.now(), baseVersion);
  const matrix = buildAuctionBlockMatrix({
    bars,
    lowerBars,
    trades,
    rows,
    grid,
    settings: input.settings,
    timeframe: input.timeframe,
    start: scope.start,
    end: scope.end
  });
  const keyLevels = calculateAuctionKeyLevels(rows, input.settings, initialBalance);
  keyLevels.dominantLvn = nodes.filter(node => node.type === "LVN").sort((left, right) => right.prominence - left.prominence)[0]?.weightedCenter ?? null;
  keyLevels.dominantHvn = nodes.filter(node => node.type === "HVN").sort((left, right) => right.normalizedScore - left.normalizedScore)[0]?.weightedCenter ?? null;
  const quality = input.settings.implementationMode === "PINE_COMPATIBILITY"
    ? {
        requestedStart: scope.start,
        requestedEnd: scope.end,
        exactTradeCoveragePercent: 0,
        lowerTimeframeCoveragePercent: lowerBars.length ? 100 : 0,
        chartBarCoveragePercent: lowerBars.length ? 0 : 100,
        unknownAggressorPercent: 100,
        missingIntervals: [],
        quality: "APPROXIMATE" as const,
        sourceMix: [lowerBars.length ? "LOWER_TIMEFRAME_BARS" as const : "CHART_BARS" as const]
      }
    : calculateProfileDataQuality(scope.start, scope.end, bars, lowerBars, trades);
  const warnings = auctionProfileLookbackWarnings(input.settings, bars.length);
  if (input.settings.implementationMode === "PINE_COMPATIBILITY") warnings.push(...PINE_CVD_PROFILE_KNOWN_ANOMALIES);
  if (quality.quality !== "EXACT") warnings.push("Historical CVD contains explicitly labeled " + quality.quality.toLowerCase() + " coverage; it is not represented as exact trade history.");
  const buildDurationMs = Math.max(0, performance.now() - startedAt);
  return {
    schemaVersion: 1,
    profileId: scope.id,
    profileVersion: baseVersion,
    engineVersion: AUCTION_PROFILE_ENGINE_VERSION,
    symbol: input.symbol,
    venue: input.venue,
    timeframe: input.timeframe,
    engine: input.settings.calculationEngine,
    implementationMode: input.settings.implementationMode,
    scope: input.settings.scopeMode,
    range: { start: scope.start, end: scope.end, loadedBars: bars.length, requestedBars: input.settings.lookbackBars },
    grid,
    rows,
    matrix,
    nodes,
    keyLevels,
    offChart: offChartSeries(bars, trades),
    quality,
    diagnostics: {
      profileHash: baseVersion,
      settingsHash,
      dataHash,
      calculationMode: input.settings.implementationMode,
      scope: input.settings.scopeMode,
      engine: input.settings.calculationEngine,
      lookback: input.settings.lookbackBars,
      rows: rows.length,
      timeBlocks: matrix.blocks.length,
      buildDurationMs,
      incrementalUpdateDurationMs: 0,
      memoryEstimateBytes: rows.length * 256 + matrix.cells.length * 168 + matrix.blocks.length * 48 + trades.length * 96 + bars.length * 48,
      exactCoveragePercent: quality.exactTradeCoveragePercent,
      fallbackCoveragePercent: quality.lowerTimeframeCoveragePercent + quality.chartBarCoveragePercent,
      nodeCount: nodes.length,
      viewportAffectsCalculation: scope.viewportDependent,
      warnings
    },
    createdAt: input.now ?? Date.now()
  };
}

export function calculateAuctionProfiles(input: AuctionProfileCalculationInput) {
  const startedAt = performance.now();
  const boundedBars = input.bars.slice(-Math.min(20000, Math.max(1, input.settings.lookbackBars)));
  const boundedInput = { ...input, bars: boundedBars };
  const scopes = resolveAuctionScopeWindows(boundedBars, input.settings, input.visibleRange);
  const snapshots = scopes.map(scope => buildScope(boundedInput, scope, startedAt));
  snapshots.slice(0, -1).forEach(snapshot => {
    snapshot.matrix.blocks.forEach(block => {
      block.isDeveloping = false;
      block.isFinalized = true;
    });
    snapshot.matrix.cells.forEach(cell => {
      cell.isDeveloping = false;
      cell.isFinalized = true;
    });
  });
  return snapshots;
}

export function calculateAuctionProfile(input: AuctionProfileCalculationInput) {
  return calculateAuctionProfiles(input).at(-1) ?? null;
}

export function appendTradesToAuctionProfile(
  snapshot: AuctionProfileSnapshot,
  trades: readonly CanonicalTrade[],
  settings: AuctionProfileCalculationInput["settings"]
) {
  const startedAt = performance.now();
  const accepted = trades.filter(trade => trade.timestamp >= snapshot.range.start && trade.timestamp <= snapshot.range.end && trade.price >= snapshot.grid.priceLow && trade.price <= snapshot.grid.priceHigh);
  if (!accepted.length) return snapshot;
  accepted.forEach(trade => allocateTrade(snapshot.rows, snapshot.grid, trade));
  appendTradesToAuctionMatrix(snapshot.matrix, accepted, snapshot.grid, settings);
  applySelectedEngine(snapshot.rows, { venue: snapshot.venue as AuctionProfileCalculationInput["venue"], symbol: snapshot.symbol, timeframe: snapshot.timeframe, bars: [], trades: [...accepted], settings, sourceRevision: snapshot.profileVersion });
  snapshot.keyLevels = calculateAuctionKeyLevels(snapshot.rows, settings, snapshot.keyLevels.ibHigh !== null && snapshot.keyLevels.ibLow !== null ? { high: snapshot.keyLevels.ibHigh, low: snapshot.keyLevels.ibLow } : undefined);
  const incrementalHash = stableHash(accepted.map(trade => [trade.timestamp, trade.tradeId, trade.price, trade.quantity, trade.aggressorSide]));
  snapshot.diagnostics.dataHash = stableHash([snapshot.diagnostics.dataHash, incrementalHash]);
  snapshot.profileVersion = auctionProfileVersion({ dataHash: snapshot.diagnostics.dataHash, settingsHash: settings.settingsVersion, grid: snapshot.grid, range: snapshot.range, engineVersion: snapshot.engineVersion });
  snapshot.nodes = detectAuctionNodes(snapshot.rows, settings, Date.now(), snapshot.profileVersion);
  snapshot.diagnostics.profileHash = snapshot.profileVersion;
  snapshot.diagnostics.nodeCount = snapshot.nodes.length;
  snapshot.diagnostics.incrementalUpdateDurationMs = performance.now() - startedAt;
  snapshot.quality.sourceMix = Array.from(new Set([...snapshot.quality.sourceMix, "LIVE_TRADE_STREAM" as const]));
  snapshot.createdAt = Date.now();
  return snapshot;
}
