import { resolveLiquiditySignificance } from "./chartDockedDepthLadderModel.ts";
import type { ProfessionalDomLadderModel, ProfessionalDomRow } from "./domProfessionalLadder";

export type DomDepthChartMode = "raw" | "smoothed" | "structural" | "macro";
export type DomDepthBias = "BID HEAVY" | "ASK HEAVY" | "BALANCED" | "UNAVAILABLE";
export type DomDepthDetailNode = { x: number; y: number; strength: number };

export type DomDepthChartModel = {
  empty: boolean;
  bidLine: string;
  askLine: string;
  bidArea: string;
  askArea: string;
  bidCurve: string;
  askCurve: string;
  bidAreaCurve: string;
  askAreaCurve: string;
  bidNodes: DomDepthDetailNode[];
  askNodes: DomDepthDetailNode[];
  bidPoints: number;
  askPoints: number;
  bidPct: number;
  askPct: number;
  bias: DomDepthBias;
  warning: string;
  note: string;
  bidHeld: boolean;
  askHeld: boolean;
  sourceBidSize: number;
  sourceAskSize: number;
  effectiveBidSize: number;
  effectiveAskSize: number;
  aggregationSize: number;
  priceStep: number;
};

export type DomDepthChartInput = {
  depth: ProfessionalDomLadderModel;
  mode?: DomDepthChartMode | string;
  bucketAggregation?: number;
  emaLength?: number;
  outlierPercentile?: number;
  curvePower?: number;
  minimumVisibleSize?: number;
  jointNormalization?: boolean;
};

type DepthLevel = { price: number; quantity: number };
type DepthSide = "bid" | "ask";

const EPSILON = 1e-12;

/**
 * Builds a quiet, two-sided cumulative depth curve from the same canonical
 * consolidated rows used by the professional ladder. An invalid one-sided
 * refresh cannot erase the opposite half: the last complete side is retained
 * and explicitly marked held until a fresh authoritative side arrives.
 */
export class DomDepthChartTracker {
  private sourceKey = "";
  private lastIdentity = "";
  private bidMemory = new Map<number, number>();
  private askMemory = new Map<number, number>();
  private bias: DomDepthBias = "BALANCED";
  private biasCandidate: DomDepthBias = "BALANCED";
  private biasCandidateCount = 0;

  update(input: DomDepthChartInput): DomDepthChartModel {
    const sourceKey = stableSourceKey(input.depth.streamKey);
    if (sourceKey !== this.sourceKey) {
      this.sourceKey = sourceKey;
      this.lastIdentity = "";
      this.bidMemory.clear();
      this.askMemory.clear();
      this.bias = "BALANCED";
      this.biasCandidate = "BALANCED";
      this.biasCandidateCount = 0;
    }

    const mode = normalizeMode(input.mode);
    const currentPrice = finitePositive(input.depth.currentPrice)
      ?? midpoint(input.depth.bestBid, input.depth.bestAsk);
    const minimumVisibleSize = Math.max(0, finite(input.minimumVisibleSize, 0));
    const freshBids = collectSide(input.depth.rows, "bid", currentPrice, minimumVisibleSize);
    const freshAsks = collectSide(input.depth.rows, "ask", currentPrice, minimumVisibleSize);
    const bidValid = freshBids.length >= 2;
    const askValid = freshAsks.length >= 2;
    const alpha = mode === "raw" ? 1 : 2 / (clampInteger(input.emaLength ?? 10, 1, 100) + 1);
    const freshIdentity = input.depth.identity !== this.lastIdentity;

    if (freshIdentity && bidValid) this.bidMemory = updateMemory(this.bidMemory, freshBids, alpha);
    if (freshIdentity && askValid) this.askMemory = updateMemory(this.askMemory, freshAsks, alpha);
    if (freshIdentity) this.lastIdentity = input.depth.identity;

    const bidHeld = !bidValid && this.bidMemory.size >= 2;
    const askHeld = !askValid && this.askMemory.size >= 2;
    const bidLevels = levelsFromMemory(this.bidMemory, "bid", currentPrice);
    const askLevels = levelsFromMemory(this.askMemory, "ask", currentPrice);
    if (bidLevels.length < 2 && askLevels.length < 2) return emptyModel(input.depth.priceStep);

    const aggregationSize = effectiveAggregationSize(mode, input.bucketAggregation ?? 4);
    const groupedBids = aggregateLevels(bidLevels, aggregationSize);
    const groupedAsks = aggregateLevels(askLevels, aggregationSize);
    const bidWeights = effectiveWeights(groupedBids, mode, input.outlierPercentile ?? 98);
    const askWeights = effectiveWeights(groupedAsks, mode, input.outlierPercentile ?? 98);
    const sourceBidSize = sum(groupedBids.map((level) => level.quantity));
    const sourceAskSize = sum(groupedAsks.map((level) => level.quantity));
    const effectiveBidSize = sum(bidWeights);
    const effectiveAskSize = sum(askWeights);
    const effectiveTotal = effectiveBidSize + effectiveAskSize;
    const bidPct = effectiveTotal > EPSILON ? effectiveBidSize / effectiveTotal * 100 : 0;
    const askPct = effectiveTotal > EPSILON ? effectiveAskSize / effectiveTotal * 100 : 0;
    const nextBias: DomDepthBias = bidPct >= 56 ? "BID HEAVY" : askPct >= 56 ? "ASK HEAVY" : "BALANCED";
    if (freshIdentity) this.updateBias(nextBias);

    const bidTotals = cumulative(bidWeights);
    const askTotals = cumulative(askWeights);
    const jointNormalization = input.jointNormalization !== false;
    const sharedMaximum = Math.max(1, bidTotals.at(-1) ?? 0, askTotals.at(-1) ?? 0);
    const curvePower = clamp(finite(input.curvePower, 0.72), 0.45, 1.4);
    const bidPoints = cumulativePoints(bidTotals, "bid", jointNormalization ? sharedMaximum : Math.max(1, bidTotals.at(-1) ?? 0), curvePower);
    const askPoints = cumulativePoints(askTotals, "ask", jointNormalization ? sharedMaximum : Math.max(1, askTotals.at(-1) ?? 0), curvePower);
    const bidPath = bidPoints.length ? orderCurvePoints([{ x: 50, y: 94 }, ...bidPoints]) : [];
    const askPath = askPoints.length ? orderCurvePoints([{ x: 50, y: 94 }, ...askPoints]) : [];
    const bidCurve = monotoneCurvePath(bidPath);
    const askCurve = monotoneCurvePath(askPath);

    return {
      empty: !bidCurve && !askCurve,
      bidLine: pointString(bidPath),
      askLine: pointString(askPath),
      bidArea: areaString(bidPath),
      askArea: areaString(askPath),
      bidCurve,
      askCurve,
      bidAreaCurve: curveAreaPath(bidCurve, bidPath),
      askAreaCurve: curveAreaPath(askCurve, askPath),
      bidNodes: structuralDetailNodes(bidPoints, bidWeights),
      askNodes: structuralDetailNodes(askPoints, askWeights),
      bidPoints: bidPath.length,
      askPoints: askPath.length,
      bidPct,
      askPct,
      bias: this.bias,
      warning: continuityWarning(bidHeld, askHeld, bidPath.length > 0, askPath.length > 0),
      note: `${mode.toUpperCase()} CLF · EMA ${mode === "raw" ? 1 : clampInteger(input.emaLength ?? 10, 1, 100)} · AGG ${aggregationSize} · P85/P99 SIGNIFICANCE`,
      bidHeld,
      askHeld,
      sourceBidSize,
      sourceAskSize,
      effectiveBidSize,
      effectiveAskSize,
      aggregationSize,
      priceStep: input.depth.priceStep
    };
  }

  reset() {
    this.sourceKey = "";
    this.lastIdentity = "";
    this.bidMemory.clear();
    this.askMemory.clear();
    this.bias = "BALANCED";
    this.biasCandidate = "BALANCED";
    this.biasCandidateCount = 0;
  }

  private updateBias(next: DomDepthBias) {
    if (next !== this.biasCandidate) {
      this.biasCandidate = next;
      this.biasCandidateCount = 1;
      return;
    }
    this.biasCandidateCount += 1;
    if (this.biasCandidateCount >= 2) this.bias = next;
  }
}

export function buildDomDepthChart(input: DomDepthChartInput) {
  return new DomDepthChartTracker().update(input);
}

function collectSide(rows: ProfessionalDomRow[], side: DepthSide, currentPrice: number | null, minimumSize: number) {
  return rows
    .filter((row) => {
      const quantity = side === "bid" ? row.bidSize : row.askSize;
      if (!Number.isFinite(row.price) || row.price <= 0 || !Number.isFinite(quantity) || quantity <= Math.max(EPSILON, minimumSize)) return false;
      if (currentPrice === null) return true;
      return side === "bid" ? row.price <= currentPrice : row.price >= currentPrice;
    })
    .map((row) => ({ price: row.price, quantity: side === "bid" ? row.bidSize : row.askSize }))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price);
}

function updateMemory(previous: Map<number, number>, levels: DepthLevel[], alpha: number) {
  const nextSource = new Map(levels.map((level) => [level.price, level.quantity]));
  const prices = new Set([...previous.keys(), ...nextSource.keys()]);
  const next = new Map<number, number>();
  for (const price of prices) {
    const prior = previous.get(price) ?? 0;
    const observed = nextSource.get(price) ?? 0;
    const smoothed = alpha >= 1 ? observed : prior + alpha * (observed - prior);
    if (smoothed > EPSILON) next.set(price, smoothed);
  }
  return next;
}

function levelsFromMemory(memory: Map<number, number>, side: DepthSide, currentPrice: number | null) {
  return [...memory.entries()]
    .map(([price, quantity]) => ({ price, quantity }))
    .filter((level) => currentPrice === null || (side === "bid" ? level.price <= currentPrice : level.price >= currentPrice))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price);
}

function aggregateLevels(levels: DepthLevel[], size: number) {
  const groups: DepthLevel[] = [];
  for (let index = 0; index < levels.length; index += size) {
    const source = levels.slice(index, index + size);
    if (!source.length) continue;
    groups.push({
      price: source.at(-1)!.price,
      quantity: sum(source.map((level) => level.quantity))
    });
  }
  return groups;
}

function effectiveWeights(levels: DepthLevel[], mode: DomDepthChartMode, outlierPercentile: number) {
  if (!levels.length) return [];
  const quantities = levels.map((level) => level.quantity).filter((value) => value > EPSILON);
  const clip = percentile(quantities, clamp(outlierPercentile / 100, 0.8, 1));
  const clipped = levels.map((level) => Math.min(level.quantity, clip));
  if (mode === "raw" || mode === "smoothed") return clipped;
  const noiseFloor = percentile(clipped, mode === "macro" ? 0.9 : 0.85);
  const reference = Math.max(percentile(clipped, 0.99), noiseFloor * 1.35, EPSILON);
  return clipped.map((value) => value * resolveLiquiditySignificance(value, noiseFloor, reference));
}

function cumulative(values: number[]) {
  let total = 0;
  return values.map((value) => {
    total += value;
    return total;
  });
}

function cumulativePoints(values: number[], side: DepthSide, maximum: number, curvePower: number) {
  return values.map((value, index) => ({
    x: 50 + (side === "bid" ? -1 : 1) * ((index + 1) / Math.max(1, values.length)) * 50,
    y: 94 - Math.pow(value / Math.max(maximum, EPSILON), curvePower) * 82
  }));
}

function orderCurvePoints(points: Array<{ x: number; y: number }>) {
  return points.slice().sort((left, right) => left.x - right.x);
}

/**
 * Fritsch-Carlson monotone cubic interpolation rounds the visual curve without
 * overshooting cumulative depth or creating synthetic peaks between buckets.
 */
function monotoneCurvePath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${formatPoint(points[0])}`;
  const intervals = points.slice(0, -1).map((point, index) => points[index + 1].x - point.x);
  const secants = intervals.map((interval, index) => interval > EPSILON ? (points[index + 1].y - points[index].y) / interval : 0);
  const tangents = new Array<number>(points.length).fill(0);
  if (points.length === 2) {
    tangents[0] = secants[0];
    tangents[1] = secants[0];
  } else {
    tangents[0] = endpointTangent(intervals[0], intervals[1], secants[0], secants[1]);
    tangents[tangents.length - 1] = endpointTangent(
      intervals[intervals.length - 1],
      intervals[intervals.length - 2],
      secants[secants.length - 1],
      secants[secants.length - 2]
    );
    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = secants[index - 1];
      const next = secants[index];
      if (previous * next <= 0) continue;
      const previousInterval = intervals[index - 1];
      const nextInterval = intervals[index];
      const weightOne = 2 * nextInterval + previousInterval;
      const weightTwo = nextInterval + 2 * previousInterval;
      tangents[index] = (weightOne + weightTwo) / (weightOne / previous + weightTwo / next);
    }
  }
  const commands = [`M ${formatPoint(points[0])}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    const interval = intervals[index];
    commands.push([
      "C",
      `${(left.x + interval / 3).toFixed(2)},${(left.y + tangents[index] * interval / 3).toFixed(2)}`,
      `${(right.x - interval / 3).toFixed(2)},${(right.y - tangents[index + 1] * interval / 3).toFixed(2)}`,
      formatPoint(right)
    ].join(" "));
  }
  return commands.join(" ");
}

function endpointTangent(primaryInterval: number, adjacentInterval: number, primarySecant: number, adjacentSecant: number) {
  const tangent = ((2 * primaryInterval + adjacentInterval) * primarySecant - primaryInterval * adjacentSecant)
    / Math.max(primaryInterval + adjacentInterval, EPSILON);
  if (tangent * primarySecant <= 0) return 0;
  if (primarySecant * adjacentSecant < 0 && Math.abs(tangent) > Math.abs(3 * primarySecant)) return 3 * primarySecant;
  return tangent;
}

function formatPoint(point: { x: number; y: number }) {
  return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
}

function curveAreaPath(curve: string, points: Array<{ x: number; y: number }>) {
  if (!curve || !points.length) return "";
  return `${curve} L ${points.at(-1)!.x.toFixed(2)},94.00 L ${points[0].x.toFixed(2)},94.00 Z`;
}

function structuralDetailNodes(points: Array<{ x: number; y: number }>, weights: number[]): DomDepthDetailNode[] {
  if (!points.length || !weights.length) return [];
  const maximum = Math.max(...weights, EPSILON);
  const threshold = percentile(weights.filter((value) => value > EPSILON), 0.68);
  return points
    .map((point, index) => ({ ...point, strength: clamp(weights[index] / maximum, 0, 1), weight: weights[index] }))
    .filter((node) => node.weight >= threshold && node.strength >= 0.16)
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 9)
    .sort((left, right) => left.x - right.x)
    .map(({ x, y, strength }) => ({ x, y, strength }));
}

function pointString(points: Array<{ x: number; y: number }>) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function areaString(points: Array<{ x: number; y: number }>) {
  if (!points.length) return "";
  return `${pointString(points)} ${points.at(-1)!.x.toFixed(2)},94 50.00,94`;
}

function continuityWarning(bidHeld: boolean, askHeld: boolean, hasBid: boolean, hasAsk: boolean) {
  if (bidHeld && askHeld) return "Both sides held from the last complete consolidated snapshot.";
  if (bidHeld) return "Bid side held from the last complete consolidated snapshot.";
  if (askHeld) return "Ask side held from the last complete consolidated snapshot.";
  if (!hasBid || !hasAsk) return "Awaiting complete consolidated bid/ask depth.";
  return "";
}

function effectiveAggregationSize(mode: DomDepthChartMode, configured: number) {
  const base = clampInteger(configured, 1, 40);
  if (mode === "raw") return 1;
  if (mode === "smoothed") return Math.max(2, base);
  if (mode === "macro") return Math.max(8, base);
  return Math.max(4, base);
}

function stableSourceKey(streamKey: string) {
  const parts = streamKey.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : streamKey;
}

function normalizeMode(value: string | undefined): DomDepthChartMode {
  return value === "raw" || value === "smoothed" || value === "macro" ? value : "structural";
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return 1;
  const sorted = values.slice().sort((left, right) => left - right);
  return Math.max(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))], EPSILON);
}

function emptyModel(priceStep: number): DomDepthChartModel {
  return {
    empty: true,
    bidLine: "",
    askLine: "",
    bidArea: "",
    askArea: "",
    bidCurve: "",
    askCurve: "",
    bidAreaCurve: "",
    askAreaCurve: "",
    bidNodes: [],
    askNodes: [],
    bidPoints: 0,
    askPoints: 0,
    bidPct: 0,
    askPct: 0,
    bias: "UNAVAILABLE",
    warning: "Awaiting complete consolidated bid/ask depth.",
    note: "CONSOLIDATED DEPTH INITIALIZING",
    bidHeld: false,
    askHeld: false,
    sourceBidSize: 0,
    sourceAskSize: 0,
    effectiveBidSize: 0,
    effectiveAskSize: 0,
    aggregationSize: 1,
    priceStep
  };
}

function finite(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function finitePositive(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function midpoint(left: number | null, right: number | null) {
  if (left !== null && right !== null) return (left + right) / 2;
  return left ?? right;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.round(clamp(Number.isFinite(value) ? value : minimum, minimum, maximum));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
