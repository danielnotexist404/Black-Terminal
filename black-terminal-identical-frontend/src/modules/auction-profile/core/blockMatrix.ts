import type { Candle } from "../../../chart-engine/types.ts";
import type { Timeframe } from "../../../market-data/types.ts";
import { estimateBarDelta } from "../data/fallback.ts";
import { parkinsonVariance } from "../engines/parkinson.ts";
import { garmanKlassVariance, realizedVariance } from "../engines/volatility.ts";
import { stableHash } from "./canonical.ts";
import { auctionRowIndex } from "./profileGrid.ts";
import type {
  AuctionBlockCell,
  AuctionBlockMatrix,
  AuctionProfileGrid,
  AuctionProfileRow,
  AuctionProfileSettings,
  AuctionTimeBlock,
  CanonicalTrade
} from "./types.ts";

const TIMEFRAME_SECONDS: Partial<Record<Timeframe, number>> = {
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
  "3h": 10_800,
  "4h": 14_400,
  "6h": 21_600,
  "8h": 28_800,
  "12h": 43_200,
  "1d": 86_400,
  "1w": 604_800,
  "1M": 2_592_000
};

type MatrixBuildInput = {
  bars: readonly Candle[];
  lowerBars: readonly Candle[];
  trades: readonly CanonicalTrade[];
  rows: AuctionProfileRow[];
  grid: AuctionProfileGrid;
  settings: AuctionProfileSettings;
  timeframe: Timeframe;
  start: number;
  end: number;
};

type MutableCell = AuctionBlockCell & { tpoBrackets?: Set<number> };

const matrixCellIndexes = new WeakMap<AuctionBlockMatrix, Map<string, AuctionBlockCell>>();
const cellTpoBrackets = new WeakMap<AuctionBlockCell, Set<number>>();

function recordTpo(cell: AuctionBlockCell, time: number, bracketSeconds: number) {
  let brackets = cellTpoBrackets.get(cell);
  if (!brackets) {
    brackets = new Set<number>();
    cellTpoBrackets.set(cell, brackets);
  }
  brackets.add(Math.floor(time / bracketSeconds));
  cell.tpoCount = brackets.size;
}

function chartSeconds(timeframe: Timeframe) {
  return TIMEFRAME_SECONDS[timeframe] ?? 60;
}

export function resolveAuctionBlockDuration(
  settings: AuctionProfileSettings,
  timeframe: Timeframe,
  start: number,
  end: number,
  hasSubChartData: boolean
) {
  const chart = chartSeconds(timeframe);
  const requested = settings.blockResolution === "CHART_TIMEFRAME" ? chart
    : settings.blockResolution === "CUSTOM" ? settings.customBlockMinutes * 60
    : settings.blockResolution === "ADAPTIVE" ? Math.ceil(Math.max(1, end - start + 1) / settings.maximumTimeBlocks)
    : TIMEFRAME_SECONDS[settings.blockResolution] ?? chart;
  let duration = Math.max(1, requested);
  if (!hasSubChartData) duration = Math.max(chart, duration);
  const span = Math.max(1, end - start + 1);
  if (Math.ceil(span / duration) > settings.maximumTimeBlocks) {
    const minimum = Math.ceil(span / settings.maximumTimeBlocks);
    const alignment = hasSubChartData ? Math.min(chart, Math.max(1, requested)) : chart;
    duration = Math.ceil(minimum / alignment) * alignment;
  }
  return duration;
}

function blockIndexFor(time: number, start: number, duration: number, count: number) {
  return Math.max(0, Math.min(count - 1, Math.floor((time - start) / duration)));
}

function barTimeForTrade(bars: readonly Candle[], time: number) {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle]!.time <= time) low = middle + 1;
    else high = middle - 1;
  }
  return high >= 0 ? bars[high]!.time : undefined;
}

function createBlocks(start: number, end: number, duration: number, developing: boolean) {
  const count = Math.max(1, Math.ceil((end - start + 1) / duration));
  return Array.from({ length: count }, (_, index): AuctionTimeBlock => {
    const startTime = start + index * duration;
    const isDeveloping = developing && index === count - 1;
    return {
      id: `block:${startTime}:${duration}`,
      index,
      startTime,
      endTime: Math.min(end, startTime + duration - 1),
      isDeveloping,
      isFinalized: !isDeveloping
    };
  });
}

function qualityRank(value: AuctionBlockCell["dataQuality"]) {
  return value === "EXACT_TRADES" ? 2 : value === "LOWER_TF_APPROXIMATION" ? 1 : 0;
}

function mergeQuality(left: AuctionBlockCell["dataQuality"], right: AuctionBlockCell["dataQuality"]) {
  return qualityRank(left) <= qualityRank(right) ? left : right;
}

function emptyCell(row: AuctionProfileRow, block: AuctionTimeBlock, quality: AuctionBlockCell["dataQuality"]): MutableCell {
  return {
    id: `cell:${block.id}:${row.index}`,
    rowIndex: row.index,
    blockIndex: block.index,
    priceLow: row.low,
    priceHigh: row.high,
    startTime: block.startTime,
    endTime: block.endTime,
    rawValue: 0,
    normalizedValue: 0,
    buyValue: 0,
    sellValue: 0,
    unknownValue: 0,
    totalValue: 0,
    notional: 0,
    tradeCount: 0,
    tpoCount: 0,
    realizedVariance: 0,
    garmanKlassVariance: 0,
    parkinsonVariance: 0,
    rangeExpansion: 0,
    sign: 0,
    isDeveloping: block.isDeveloping,
    isFinalized: block.isFinalized,
    dataQuality: quality
  };
}

function ensureCell(
  cells: Map<string, MutableCell>,
  row: AuctionProfileRow,
  block: AuctionTimeBlock,
  quality: AuctionBlockCell["dataQuality"]
) {
  const key = `${block.index}:${row.index}`;
  const current = cells.get(key);
  if (current) {
    current.dataQuality = mergeQuality(current.dataQuality, quality);
    return current;
  }
  const created = emptyCell(row, block, quality);
  cells.set(key, created);
  return created;
}

function allocationWeights(bar: Candle, start: number, end: number, rows: readonly AuctionProfileRow[], mode: string) {
  const typical = (bar.high + bar.low + bar.close) / 3;
  const weights = Array.from({ length: end - start + 1 }, (_, offset) => {
    const row = rows[start + offset]!;
    const center = row.center;
    if (mode === "CLOSE_WEIGHTED") return 1 / (1 + Math.abs(center - bar.close) / Math.max(row.high - row.low, Number.EPSILON));
    if (mode === "TYPICAL_PRICE_WEIGHTED") return 1 / (1 + Math.abs(center - typical) / Math.max(row.high - row.low, Number.EPSILON));
    if (mode === "GAUSSIAN_AROUND_VWAP") {
      const sigma = Math.max((bar.high - bar.low) / 4, Number.EPSILON);
      return Math.exp(-0.5 * ((center - typical) / sigma) ** 2);
    }
    if (mode === "BODY_WICK_WEIGHTED" || mode === "HYBRID") {
      const bodyLow = Math.min(bar.open, bar.close);
      const bodyHigh = Math.max(bar.open, bar.close);
      const body = center >= bodyLow && center <= bodyHigh ? 2.5 : 0.65;
      return mode === "HYBRID" ? body / (1 + Math.abs(center - typical) / Math.max(bar.high - bar.low, Number.EPSILON)) : body;
    }
    return 1;
  });
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return weights.map(value => value / total);
}

function annualization(settings: AuctionProfileSettings) {
  if (settings.volatilityAnnualization === "NONE") return 1;
  if (settings.volatilityAnnualization === "CUSTOM") return settings.annualizationPeriods;
  return 365;
}

function metricValue(cell: AuctionBlockCell, settings: AuctionProfileSettings, pineCvd?: number) {
  const delta = pineCvd ?? cell.buyValue - cell.sellValue;
  const directionalTotal = cell.buyValue + cell.sellValue;
  const engine = settings.calculationEngine;
  if (engine === "CVD_REAL_TRADES" || engine === "CVD_PINE_COMPATIBLE") {
    if (settings.cvdMetric === "ABSOLUTE_CVD") return Math.abs(delta);
    if (settings.cvdMetric === "POSITIVE_CVD") return Math.max(0, delta);
    if (settings.cvdMetric === "NEGATIVE_CVD") return Math.min(0, delta);
    if (settings.cvdMetric === "CVD_IMBALANCE_RATIO" || settings.cvdMetric === "CVD_EFFICIENCY") return delta / Math.max(directionalTotal, Number.EPSILON);
    if (settings.cvdMetric === "CVD_PERSISTENCE") return Math.abs(delta) / Math.max(directionalTotal, Number.EPSILON);
    if (settings.cvdMetric === "CVD_DIVERGENCE") return delta / Math.max(cell.rangeExpansion, Number.EPSILON);
    return delta;
  }
  if (engine === "BUY_VOLUME") return cell.buyValue;
  if (engine === "SELL_VOLUME") return cell.sellValue;
  if (engine === "DELTA_VOLUME") return delta;
  if (engine === "IMBALANCE_RATIO") return delta / Math.max(directionalTotal, Number.EPSILON);
  if (engine === "TRADE_COUNT") return cell.tradeCount;
  if (engine === "AVERAGE_TRADE_SIZE") return cell.tradeCount ? cell.totalValue / cell.tradeCount : 0;
  if (engine === "TPO") return cell.tpoCount;
  if (engine === "ACTIVITY") return (cell.tradeCount + Math.sqrt(Math.max(0, cell.totalValue))) * (0.5 + Math.abs(delta) / Math.max(cell.totalValue, Number.EPSILON));
  if (engine === "USD_VOLUME") return cell.notional;
  if (engine === "REALIZED_VOLATILITY") return Math.sqrt(Math.max(0, cell.realizedVariance) * annualization(settings));
  if (engine === "PARKINSON_VOLATILITY") return Math.sqrt(Math.max(0, cell.parkinsonVariance) * annualization(settings));
  if (engine === "GARMAN_KLASS_VOLATILITY") return Math.sqrt(Math.max(0, cell.garmanKlassVariance) * annualization(settings));
  if (engine === "RANGE_EXPANSION") return cell.rangeExpansion;
  if (engine === "LIQUIDITY_WEIGHTED_ACTIVITY") return Math.log1p(cell.totalValue) * (1 + Math.abs(delta) / Math.max(cell.totalValue, Number.EPSILON));
  if (engine === "HYBRID_AUCTION_SCORE") return cell.totalValue * settings.hybridWeights.volume + delta * settings.hybridWeights.cvd + cell.tpoCount * settings.hybridWeights.tpo + cell.notional * settings.hybridWeights.notional;
  return cell.totalValue;
}

function percentile(sorted: readonly number[], percentileValue: number) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, (percentileValue / 100) * (sorted.length - 1)));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}

function normalizeValue(value: number, lower: number, upper: number, mode: "LINEAR" | "LOGARITHMIC" | "SQUARE_ROOT" = "LINEAR") {
  const absolute = Math.abs(value);
  const scaled = mode === "LOGARITHMIC"
    ? Math.log1p(absolute) / Math.max(Math.log1p(upper), Number.EPSILON)
    : mode === "SQUARE_ROOT"
      ? Math.sqrt(absolute) / Math.max(Math.sqrt(upper), Number.EPSILON)
      : (absolute - lower) / Math.max(upper - lower, Number.EPSILON);
  return Math.sign(value) * Math.max(0, Math.min(1, scaled));
}

export function normalizeAuctionMatrixCells(cells: AuctionBlockCell[], settings: AuctionProfileSettings) {
  const values = cells.map(cell => Math.abs(cell.rawValue)).filter(value => value > 0).sort((a, b) => a - b);
  const mode = settings.rendering.normalizationMode;
  const globalLower = mode === "ROBUST_PERCENTILE" ? percentile(values, settings.rendering.robustLowerPercentile) : 0;
  const globalUpper = mode === "ABSOLUTE_FIXED" ? settings.rendering.absoluteFixedScale
    : mode === "ROBUST_PERCENTILE" || mode === "PERCENTILE" ? percentile(values, mode === "PERCENTILE" ? 95 : settings.rendering.robustUpperPercentile)
    : values.at(-1) ?? 1;
  if (mode === "PER_TIME_BLOCK") {
    const byBlock = new Map<number, AuctionBlockCell[]>();
    cells.forEach(cell => byBlock.set(cell.blockIndex, [...(byBlock.get(cell.blockIndex) ?? []), cell]));
    byBlock.forEach(blockCells => {
      const maximum = Math.max(...blockCells.map(cell => Math.abs(cell.rawValue)), Number.EPSILON);
      blockCells.forEach(cell => { cell.normalizedValue = normalizeValue(cell.rawValue, 0, maximum); });
    });
  } else if (mode === "ROLLING") {
    cells.forEach(cell => {
      const nearby = cells.filter(candidate => Math.abs(candidate.blockIndex - cell.blockIndex) <= 20).map(candidate => Math.abs(candidate.rawValue));
      cell.normalizedValue = normalizeValue(cell.rawValue, 0, Math.max(...nearby, Number.EPSILON));
    });
  } else {
    cells.forEach(cell => { cell.normalizedValue = normalizeValue(cell.rawValue, globalLower, globalUpper, mode === "LOGARITHMIC" ? "LOGARITHMIC" : mode === "SQUARE_ROOT" ? "SQUARE_ROOT" : "LINEAR"); });
  }
  cells.forEach(cell => { cell.sign = Math.sign(cell.rawValue) as -1 | 0 | 1; });
  return { lower: globalLower, upper: Math.max(globalUpper, Number.EPSILON) };
}

export function buildAuctionBlockMatrix(input: MatrixBuildInput): AuctionBlockMatrix {
  const duration = resolveAuctionBlockDuration(input.settings, input.timeframe, input.start, input.end, input.trades.length > 0 || input.lowerBars.length > 0);
  const blocks = createBlocks(input.start, input.end, duration, input.settings.updateDevelopingBlock && !input.settings.compositeLocked);
  const cells = new Map<string, MutableCell>();
  const pineCvd = new Map<string, number>();
  const exactBarTimes = new Set<number>();
  const bracketSeconds = Math.max(60, input.settings.tpoBracketMinutes * 60);

  if (input.settings.implementationMode === "BLACK_CORE_NATIVE") {
    input.trades.forEach(trade => {
      if (trade.timestamp < input.start || trade.timestamp > input.end || trade.price < input.grid.priceLow || trade.price > input.grid.priceHigh) return;
      const row = input.rows[auctionRowIndex(input.grid, trade.price)]!;
      const block = blocks[blockIndexFor(trade.timestamp, input.start, duration, blocks.length)]!;
      const cell = ensureCell(cells, row, block, "EXACT_TRADES");
      if (trade.aggressorSide === "BUY") cell.buyValue += trade.quantity;
      else if (trade.aggressorSide === "SELL") cell.sellValue += trade.quantity;
      else cell.unknownValue += trade.quantity;
      cell.totalValue += trade.quantity;
      cell.notional += trade.notional;
      cell.tradeCount += 1;
      recordTpo(cell, trade.timestamp, bracketSeconds);
      const barTime = barTimeForTrade(input.bars, trade.timestamp);
      if (barTime !== undefined) exactBarTimes.add(barTime);
    });
  }

  const sourceBars = input.lowerBars.length ? input.lowerBars : input.bars;
  const allowFallback = input.settings.implementationMode === "PINE_COMPATIBILITY" || ["HYBRID", "LOWER_TIMEFRAME_BARS", "CHART_BARS"].includes(input.settings.dataSource);
  if (allowFallback) {
    let previousClose: number | undefined;
    sourceBars.forEach(bar => {
      const containingChartBar = barTimeForTrade(input.bars, bar.time);
      if (bar.time < input.start || bar.time > input.end || (containingChartBar !== undefined && exactBarTimes.has(containingChartBar))) return;
      const block = blocks[blockIndexFor(bar.time, input.start, duration, blocks.length)]!;
      const startRow = auctionRowIndex(input.grid, bar.low);
      const endRow = auctionRowIndex(input.grid, bar.high);
      const weights = input.settings.implementationMode === "PINE_COMPATIBILITY"
        ? Array.from({ length: endRow - startRow + 1 }, () => 1 / Math.max(1, endRow - startRow + 1))
        : allocationWeights(bar, startRow, endRow, input.rows, input.settings.priceAllocation);
      const estimated = estimateBarDelta(bar);
      const priorClose = previousClose;
      const direction = priorClose === undefined ? 0 : Math.sign(bar.close - priorClose);
      previousClose = bar.close;
      const quality: AuctionBlockCell["dataQuality"] = input.lowerBars.length ? "LOWER_TF_APPROXIMATION" : "CHART_BAR_APPROXIMATION";
      for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
        const row = input.rows[rowIndex]!;
        const weight = weights[rowIndex - startRow]!;
        const cell = ensureCell(cells, row, block, quality);
        let allocatedTotal = 0;
        if (input.settings.implementationMode === "PINE_COMPATIBILITY") {
          const divided = direction * bar.volume * weight;
          const key = `${block.index}:${row.index}`;
          pineCvd.set(key, (pineCvd.get(key) ?? 0) + divided);
          if (divided > 0) cell.buyValue = Math.abs(divided);
          if (divided < 0) cell.sellValue = Math.abs(divided);
          cell.totalValue += Math.abs(divided);
          allocatedTotal = Math.abs(divided);
        } else {
          const buy = estimated.buyQuantity * weight;
          const sell = estimated.sellQuantity * weight;
          const unknown = estimated.unknownQuantity * weight;
          cell.buyValue += buy;
          cell.sellValue += sell;
          cell.unknownValue += unknown;
          cell.totalValue += buy + sell + unknown;
          allocatedTotal = buy + sell + unknown;
        }
        cell.notional += allocatedTotal * row.center;
        cell.realizedVariance += realizedVariance(bar, priorClose) * weight;
        cell.parkinsonVariance += parkinsonVariance(bar) * weight;
        cell.garmanKlassVariance += garmanKlassVariance(bar) * weight;
        cell.rangeExpansion += Math.max(0, bar.high - bar.low) * weight;
        recordTpo(cell, bar.time, bracketSeconds);
      }
    });
  }

  const finalizedCells = [...cells.values()].map(cell => {
    cell.rawValue = metricValue(cell, input.settings, pineCvd.get(`${cell.blockIndex}:${cell.rowIndex}`));
    delete cell.tpoBrackets;
    return cell as AuctionBlockCell;
  }).sort((left, right) => left.blockIndex - right.blockIndex || left.rowIndex - right.rowIndex);
  if (["CVD_REAL_TRADES", "CVD_PINE_COMPATIBLE"].includes(input.settings.calculationEngine) && input.settings.cvdMetric === "CVD_ACCELERATION") {
    const deltas = new Map(finalizedCells.map(cell => [`${cell.blockIndex}:${cell.rowIndex}`, cell.buyValue - cell.sellValue]));
    finalizedCells.forEach(cell => {
      const delta = cell.buyValue - cell.sellValue;
      cell.rawValue = delta - (deltas.get(`${cell.blockIndex - 1}:${cell.rowIndex}`) ?? 0);
    });
  }
  const normalization = normalizeAuctionMatrixCells(finalizedCells, input.settings);
  const matrix: AuctionBlockMatrix = {
    rows: input.rows,
    blocks,
    cells: finalizedCells,
    blockDurationSeconds: duration,
    normalizationLower: normalization.lower,
    normalizationUpper: normalization.upper,
    normalizationMode: input.settings.rendering.normalizationMode,
    sourceCellCount: finalizedCells.length,
    matrixVersion: "auction-matrix-" + stableHash(finalizedCells.map(cell => [cell.blockIndex, cell.rowIndex, cell.rawValue, cell.dataQuality]))
  };
  matrixCellIndexes.set(matrix, new Map(matrix.cells.map(cell => [`${cell.blockIndex}:${cell.rowIndex}`, cell])));
  return matrix;
}

export function appendTradesToAuctionMatrix(
  matrix: AuctionBlockMatrix,
  trades: readonly CanonicalTrade[],
  grid: AuctionProfileGrid,
  settings: AuctionProfileSettings
) {
  let cells = matrixCellIndexes.get(matrix);
  if (!cells) {
    cells = new Map(matrix.cells.map(cell => [`${cell.blockIndex}:${cell.rowIndex}`, cell]));
    matrixCellIndexes.set(matrix, cells);
  }
  let updates = 0;
  let added = false;
  for (const trade of trades) {
    const blockIndex = Math.floor((trade.timestamp - matrix.blocks[0]!.startTime) / matrix.blockDurationSeconds);
    const block = matrix.blocks[blockIndex];
    if (!block || trade.price < grid.priceLow || trade.price > grid.priceHigh) continue;
    const row = matrix.rows[auctionRowIndex(grid, trade.price)]!;
    const key = `${blockIndex}:${row.index}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = emptyCell(row, block, "EXACT_TRADES");
      matrix.cells.push(cell);
      cells.set(key, cell);
      added = true;
    }
    if (trade.aggressorSide === "BUY") cell.buyValue += trade.quantity;
    else if (trade.aggressorSide === "SELL") cell.sellValue += trade.quantity;
    else cell.unknownValue += trade.quantity;
    cell.totalValue += trade.quantity;
    cell.notional += trade.notional;
    cell.tradeCount += 1;
    recordTpo(cell, trade.timestamp, Math.max(60, settings.tpoBracketMinutes * 60));
    cell.rawValue = metricValue(cell, settings);
    if (settings.cvdMetric === "CVD_ACCELERATION") {
      const previous = cells.get(`${blockIndex - 1}:${row.index}`);
      cell.rawValue = cell.buyValue - cell.sellValue - (previous ? previous.buyValue - previous.sellValue : 0);
    }
    cell.sign = Math.sign(cell.rawValue) as -1 | 0 | 1;
    cell.normalizedValue = normalizeValue(cell.rawValue, matrix.normalizationLower, matrix.normalizationUpper, matrix.normalizationMode === "LOGARITHMIC" ? "LOGARITHMIC" : matrix.normalizationMode === "SQUARE_ROOT" ? "SQUARE_ROOT" : "LINEAR");
    cell.dataQuality = "EXACT_TRADES";
    updates += 1;
  }
  if (settings.rendering.colorScalingLifecycle === "DEVELOPING_GLOBAL") {
    const normalization = normalizeAuctionMatrixCells(matrix.cells, settings);
    matrix.normalizationLower = normalization.lower;
    matrix.normalizationUpper = normalization.upper;
  }
  if (added) matrix.cells.sort((left, right) => left.blockIndex - right.blockIndex || left.rowIndex - right.rowIndex);
  matrix.sourceCellCount = matrix.cells.length;
  matrix.matrixVersion = "auction-matrix-" + stableHash([matrix.matrixVersion, trades.map(trade => trade.tradeId)]);
  return updates;
}
