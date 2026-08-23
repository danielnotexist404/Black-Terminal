import { priceToScreenY, screenYToPrice, type ChartPriceTransformSnapshot } from "../../chart-engine/priceTransform.ts";
import type { ProfessionalDomLadderModel, ProfessionalDomSide } from "./domProfessionalLadder";
import type { WallDetection } from "./types";

export type ChartDockedDepthCoverage = "live" | "unavailable";
export type ChartDockedDepthScaleMode = "chart" | "follow" | "book" | "locked";

export type ChartDockedDepthRow = {
  key: string;
  index: number;
  top: number;
  height: number;
  price: number;
  priceHigh: number;
  priceLow: number;
  bidSize: number;
  askSize: number;
  totalSize: number;
  signedSize: number;
  delta: number;
  bidCumulative: number;
  askCumulative: number;
  depthRatio: number;
  activityRatio: number;
  side: ProfessionalDomSide;
  coverage: ChartDockedDepthCoverage;
  isCurrentPrice: boolean;
  wall: WallDetection | null;
};

export type ChartDockedDepthLadderModel = {
  viewportRevision: number;
  rows: ChartDockedDepthRow[];
  plotTop: number;
  plotBottom: number;
  rowHeight: number;
  currentPrice: number | null;
  currentPriceY: number | null;
  priceMin: number;
  priceMax: number;
  priceSpan: number;
  priceStep: number;
  depthReference: number;
  bidNoiseFloor: number;
  askNoiseFloor: number;
  bidDepthReference: number;
  askDepthReference: number;
  sourceBidSize: number;
  sourceAskSize: number;
  coverageMin: number | null;
  coverageMax: number | null;
  subscribedDepth: number | null;
  sequence: number | null;
  state: ProfessionalDomLadderModel["state"];
  priceDecimals: number;
  visibleBidSize: number;
  visibleAskSize: number;
  hiddenAboveCount: number;
  hiddenBelowCount: number;
  scaleMode: ChartDockedDepthScaleMode;
};

type ChartDockedDepthLadderInput = {
  depth: ProfessionalDomLadderModel;
  viewport: ChartPriceTransformSnapshot;
  preferredRowHeight?: number;
  maximumRows?: number;
  scaleMode?: ChartDockedDepthScaleMode;
};

type MutableRow = ChartDockedDepthRow;

export type StableLiquidityProjection = {
  minimumPrice: number;
  maximumPrice: number;
  rowCount: number;
  priceStep: number;
};

const EPSILON = 1e-12;
export const CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD = 26_000;

/**
 * Converts the ladder's aggregation control into a useful number of canonical
 * projection rows. The previous hard floor of 80 made 20x, 50x and 100x nearly
 * indistinguishable on a normal dock. Square-root scaling keeps the low-detail
 * presets responsive without letting the raw preset exceed the API contract.
 */
export function resolveChartDockedProjectionRowCount(plotHeight: number, aggregationTicks: number) {
  const nativeRows = Math.max(1, plotHeight / 13);
  const aggregation = clamp(Number.isFinite(aggregationTicks) ? aggregationTicks : 20, 1, 100);
  return clampInteger(nativeRows * Math.sqrt(20 / aggregation), 24, 220);
}

/**
 * Maps genuine resting size into visual prominence without allowing the dense
 * background book to masquerade as a wall. Values below the adaptive noise
 * floor retain a faint audit trace; only statistical outliers receive long,
 * bright shelves. Raw quantities and cumulative totals remain unchanged.
 */
export function resolveLiquiditySignificance(value: number, noiseFloor: number, depthReference: number) {
  if (!Number.isFinite(value) || value <= EPSILON) return 0;
  const floor = Number.isFinite(noiseFloor) ? Math.max(0, noiseFloor) : 0;
  const reference = Number.isFinite(depthReference) ? Math.max(floor + EPSILON, depthReference) : floor + EPSILON;
  if (floor > EPSILON && value < floor) {
    return clamp(0.035 * (value / floor) ** 1.5, 0.002, 0.035);
  }
  const normalized = clamp((value - floor) / Math.max(reference - floor, EPSILON), 0, 1);
  return clamp(0.08 + 0.92 * normalized ** 0.72, 0.08, 1);
}

/**
 * Chooses a globally anchored price grid for a chart viewport. Moving the chart
 * without changing its scale can add/remove canonical buckets at the edges, but
 * can never redefine the price bounds or identity of an existing bucket.
 */
export function buildStableLiquidityProjection(
  viewport: ChartPriceTransformSnapshot,
  targetRows: number,
  bufferRows = 4
): StableLiquidityProjection {
  const safeTargetRows = clampInteger(targetRows, 8, 220);
  const priceStep = niceStepAtLeast((viewport.priceMax - viewport.priceMin) / safeTargetRows);
  const padding = clampInteger(bufferRows, 0, 10);
  const minimumIndex = Math.max(1, Math.ceil(viewport.priceMin / priceStep - 0.5) - padding);
  const maximumIndex = Math.max(minimumIndex, Math.floor(viewport.priceMax / priceStep + 0.5) + padding);
  return {
    minimumPrice: Math.max(EPSILON, (minimumIndex - 0.5) * priceStep),
    maximumPrice: (maximumIndex + 0.5) * priceStep,
    rowCount: maximumIndex - minimumIndex + 1,
    priceStep
  };
}

export function translateChartViewportToDock(
  chartViewport: ChartPriceTransformSnapshot,
  offsetY: number
): ChartPriceTransformSnapshot {
  if (!Number.isFinite(offsetY) || Math.abs(offsetY) <= EPSILON) return chartViewport;
  return {
    ...chartViewport,
    height: Math.max(1, chartViewport.height + offsetY),
    plotTop: chartViewport.plotTop + offsetY,
    plotBottom: chartViewport.plotBottom + offsetY
  };
}

/**
 * Extends the chart's authoritative price transform through the ladder's taller
 * render area. Every price inside the chart remains at the exact same screen Y;
 * the additional ladder area simply continues the same pixels-per-price scale.
 */
export function buildChartSynchronizedViewport(
  chartViewport: ChartPriceTransformSnapshot,
  renderViewport: ChartPriceTransformSnapshot
): ChartPriceTransformSnapshot {
  const priceAtTop = screenYToPrice(renderViewport.plotTop, chartViewport);
  const priceAtBottom = screenYToPrice(renderViewport.plotBottom, chartViewport);
  if (priceAtTop === null || priceAtBottom === null || !Number.isFinite(priceAtTop) || !Number.isFinite(priceAtBottom)) {
    return renderViewport;
  }
  return {
    ...renderViewport,
    scaleMode: chartViewport.scaleMode,
    priceMin: Math.min(priceAtTop, priceAtBottom),
    priceMax: Math.max(priceAtTop, priceAtBottom)
  };
}

export function buildChartDockedDepthLadder(input: ChartDockedDepthLadderInput): ChartDockedDepthLadderModel {
  const { depth } = input;
  const scaleMode = input.scaleMode ?? "follow";
  const viewport = scaleMode === "book" ? fitViewportToDeliveredBook(input.viewport, depth) : input.viewport;
  const plotHeight = Math.max(0, viewport.plotBottom - viewport.plotTop);
  const preferredRowHeight = clamp(input.preferredRowHeight ?? 13, 9, 24);
  const maximumRows = clampInteger(input.maximumRows ?? 180, 8, 2_000);
  const sourceStep = Math.max(EPSILON, depth.priceStep);
  const sourceMinimumIndex = Math.ceil(viewport.priceMin / sourceStep - 0.5);
  const sourceMaximumIndex = Math.floor(viewport.priceMax / sourceStep + 0.5);
  const sourceRowCount = Math.max(0, sourceMaximumIndex - sourceMinimumIndex + 1);
  const compression = Math.max(1, Math.ceil(sourceRowCount / maximumRows));
  const priceStep = sourceStep * compression;
  const minimumIndex = Math.ceil(viewport.priceMin / priceStep - 0.5);
  const maximumIndex = Math.floor(viewport.priceMax / priceStep + 0.5);
  const rows: MutableRow[] = [];

  for (let priceIndex = maximumIndex; priceIndex >= minimumIndex; priceIndex -= 1) {
    const price = priceIndex * priceStep;
    const priceHigh = price + priceStep / 2;
    const priceLow = Math.max(EPSILON, price - priceStep / 2);
    const highY = priceToScreenY(priceHigh, viewport);
    const lowY = priceToScreenY(priceLow, viewport);
    if (highY === null || lowY === null) continue;
    const top = Math.max(viewport.plotTop, Math.min(highY, lowY));
    const bottom = Math.min(viewport.plotBottom, Math.max(highY, lowY));
    if (bottom - top <= EPSILON) continue;
    const coverage = depth.coverageMin !== null && depth.coverageMax !== null
      && priceHigh >= depth.coverageMin && priceLow <= depth.coverageMax
      ? "live"
      : "unavailable";
    rows.push({
      key: `${depth.streamKey}:${stableNumber(priceStep)}:${priceIndex}`,
      index: rows.length,
      top,
      height: bottom - top,
      price,
      priceHigh,
      priceLow,
      bidSize: 0,
      askSize: 0,
      totalSize: 0,
      signedSize: 0,
      delta: 0,
      bidCumulative: 0,
      askCumulative: 0,
      depthRatio: 0,
      activityRatio: 0,
      side: "empty",
      coverage,
      isCurrentPrice: false,
      wall: null
    });
  }

  const rowHeight = rows.length > 0 ? plotHeight / rows.length : preferredRowHeight;
  const rowsByPriceIndex = new Map(rows.map((row) => [Math.round(row.price / priceStep), row]));

  let hiddenAboveCount = 0;
  let hiddenBelowCount = 0;
  for (const source of depth.rows) {
    if (source.totalSize <= EPSILON && Math.abs(source.delta) <= EPSILON && !source.wall) continue;
    const y = priceToScreenY(source.price, viewport);
    if (y === null || y < viewport.plotTop) {
      if (source.totalSize > EPSILON) hiddenAboveCount += 1;
      continue;
    }
    if (y > viewport.plotBottom) {
      if (source.totalSize > EPSILON) hiddenBelowCount += 1;
      continue;
    }
    const target = rowsByPriceIndex.get(Math.round(source.price / priceStep));
    if (!target) continue;
    target.bidSize += source.bidSize;
    target.askSize += source.askSize;
    target.delta += source.delta;
    target.coverage = "live";
    if (source.wall && (!target.wall || source.wall.score > target.wall.score)) target.wall = source.wall;
  }

  const currentY = depth.currentPrice === null ? null : priceToScreenY(depth.currentPrice, viewport);
  const currentIndex = depth.currentPrice === null
    ? -1
    : rows.findIndex((row) => depth.currentPrice! >= row.priceLow && depth.currentPrice! <= row.priceHigh);
  if (currentY !== null && currentY >= viewport.plotTop && currentY <= viewport.plotBottom && currentIndex >= 0) {
    rows[currentIndex].isCurrentPrice = true;
  }

  const sourceDepthByIndex = new Map<number, { bidSize: number; askSize: number }>();
  for (const source of depth.rows) {
    const index = Math.round(source.price / priceStep);
    const target = sourceDepthByIndex.get(index) ?? { bidSize: 0, askSize: 0 };
    target.bidSize += source.bidSize;
    target.askSize += source.askSize;
    sourceDepthByIndex.set(index, target);
  }
  const bidDistribution = distributionThresholds(
    [...sourceDepthByIndex.values()].map((row) => row.bidSize).filter((value) => value > EPSILON)
  );
  const askDistribution = distributionThresholds(
    [...sourceDepthByIndex.values()].map((row) => row.askSize).filter((value) => value > EPSILON)
  );
  const depthReference = Math.max(bidDistribution.reference, askDistribution.reference, EPSILON);
  rows.forEach((row) => {
    row.totalSize = row.bidSize + row.askSize;
    row.signedSize = row.bidSize - row.askSize;
    row.side = classifySide(row.bidSize, row.askSize);
    row.depthRatio = Math.max(
      resolveLiquiditySignificance(row.bidSize, bidDistribution.noiseFloor, bidDistribution.reference),
      resolveLiquiditySignificance(row.askSize, askDistribution.noiseFloor, askDistribution.reference)
    );
    const relativeDelta = row.totalSize > EPSILON
      ? Math.abs(row.delta) / Math.max(row.totalSize, Math.abs(row.delta), EPSILON)
      : 0;
    row.activityRatio = clamp(Math.sqrt(relativeDelta), 0, 1);
  });

  const sourceIndices = [...sourceDepthByIndex.keys()].sort((left, right) => left - right);
  const referenceIndex = depth.currentPrice === null
    ? Math.round(((depth.bestBid ?? depth.bestAsk ?? 0) / priceStep))
    : Math.round(depth.currentPrice / priceStep);
  const minimumSourceIndex = sourceIndices[0] ?? referenceIndex;
  const maximumSourceIndex = sourceIndices.at(-1) ?? referenceIndex;
  let askCumulative = 0;
  const askCumulativeByIndex = new Map<number, number>();
  for (let index = Math.max(minimumSourceIndex, referenceIndex); index <= maximumSourceIndex; index += 1) {
    askCumulative += sourceDepthByIndex.get(index)?.askSize ?? 0;
    askCumulativeByIndex.set(index, askCumulative);
  }
  let bidCumulative = 0;
  const bidCumulativeByIndex = new Map<number, number>();
  for (let index = Math.min(maximumSourceIndex, referenceIndex); index >= minimumSourceIndex; index -= 1) {
    bidCumulative += sourceDepthByIndex.get(index)?.bidSize ?? 0;
    bidCumulativeByIndex.set(index, bidCumulative);
  }
  rows.forEach((row) => {
    const index = Math.round(row.price / priceStep);
    row.askCumulative = askCumulativeByIndex.get(index) ?? 0;
    row.bidCumulative = bidCumulativeByIndex.get(index) ?? 0;
  });

  return {
    viewportRevision: viewport.revision,
    rows,
    plotTop: viewport.plotTop,
    plotBottom: viewport.plotBottom,
    rowHeight,
    currentPrice: depth.currentPrice,
    currentPriceY: currentY !== null && currentY >= viewport.plotTop && currentY <= viewport.plotBottom ? currentY : null,
    priceMin: viewport.priceMin,
    priceMax: viewport.priceMax,
    priceSpan: viewport.priceMax - viewport.priceMin,
    priceStep,
    depthReference,
    bidNoiseFloor: bidDistribution.noiseFloor,
    askNoiseFloor: askDistribution.noiseFloor,
    bidDepthReference: bidDistribution.reference,
    askDepthReference: askDistribution.reference,
    sourceBidSize: depth.totalBidSize,
    sourceAskSize: depth.totalAskSize,
    coverageMin: depth.coverageMin,
    coverageMax: depth.coverageMax,
    subscribedDepth: depth.subscribedDepth,
    sequence: depth.sequence,
    state: depth.state,
    priceDecimals: Math.max(1, depth.priceDecimals),
    visibleBidSize: rows.reduce((total, row) => total + row.bidSize, 0),
    visibleAskSize: rows.reduce((total, row) => total + row.askSize, 0),
    hiddenAboveCount,
    hiddenBelowCount,
    scaleMode
  };
}

/**
 * Builds the moving full-range ladder scale while preserving the live price's
 * exact vertical chart coordinate. The chart can pan or rescale independently;
 * the ladder still exposes a stable dollar span and remains visually registered
 * to the chart's current-price marker.
 */
export function buildPriceFollowingViewport(
  chartViewport: ChartPriceTransformSnapshot,
  referencePrice: number,
  priceSpan = CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD,
  renderViewport: ChartPriceTransformSnapshot = chartViewport
): ChartPriceTransformSnapshot {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(priceSpan) || priceSpan <= EPSILON) {
    return renderViewport;
  }
  const chartY = priceToScreenY(referencePrice, chartViewport);
  const plotHeight = renderViewport.plotBottom - renderViewport.plotTop;
  if (chartY === null || !Number.isFinite(plotHeight) || plotHeight <= EPSILON) return renderViewport;

  const topRatio = clamp((chartY - renderViewport.plotTop) / plotHeight, 0, 1);
  const priceMin = renderViewport.scaleMode === "logarithmic"
    ? solveLogarithmicMinimum(referencePrice, priceSpan, 1 - topRatio)
    : referencePrice - (1 - topRatio) * priceSpan;
  const safeMinimum = Math.max(Math.min(referencePrice, priceMin), Math.max(EPSILON, referencePrice * 1e-12));
  return {
    ...renderViewport,
    priceMin: safeMinimum,
    priceMax: safeMinimum + priceSpan
  };
}

export function fitViewportToDeliveredBook(
  viewport: ChartPriceTransformSnapshot,
  depth: ProfessionalDomLadderModel
): ChartPriceTransformSnapshot {
  const coverageMin = depth.coverageMin;
  const coverageMax = depth.coverageMax;
  if (coverageMin === null || coverageMax === null || !Number.isFinite(coverageMin) || !Number.isFinite(coverageMax)) return viewport;

  const span = coverageMax - coverageMin;
  if (span > EPSILON) return { ...viewport, priceMin: coverageMin, priceMax: coverageMax };

  const halfStep = Math.max(depth.priceStep / 2, Math.abs(coverageMin) * 1e-8, EPSILON);
  return { ...viewport, priceMin: Math.max(EPSILON, coverageMin - halfStep), priceMax: coverageMax + halfStep };
}

function solveLogarithmicMinimum(referencePrice: number, priceSpan: number, fractionBelow: number) {
  if (fractionBelow <= EPSILON) return referencePrice;
  if (fractionBelow >= 1 - EPSILON) return Math.max(EPSILON, referencePrice - priceSpan);

  let low = Math.max(EPSILON, referencePrice - priceSpan);
  let high = referencePrice;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (low + high) / 2;
    const denominator = Math.log(middle + priceSpan) - Math.log(middle);
    const actualFraction = denominator > EPSILON
      ? (Math.log(referencePrice) - Math.log(middle)) / denominator
      : 0;
    if (actualFraction > fractionBelow) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function classifySide(bidSize: number, askSize: number): ProfessionalDomSide {
  if (bidSize > EPSILON && askSize > EPSILON) return "mixed";
  if (askSize > EPSILON) return "ask";
  if (bidSize > EPSILON) return "bid";
  return "empty";
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((left, right) => left - right);
  return Math.max(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))], EPSILON);
}

function distributionThresholds(values: number[]) {
  if (values.length === 0) return { noiseFloor: 0, reference: 1 };
  const maximum = Math.max(...values);
  if (values.length <= 4) return { noiseFloor: 0, reference: Math.max(maximum, EPSILON) };
  const noiseFloor = percentile(values, 0.85);
  const reference = Math.max(percentile(values, 0.99), noiseFloor * 1.35, EPSILON);
  return { noiseFloor, reference };
}

function niceStepAtLeast(value: number) {
  if (!Number.isFinite(value) || value <= EPSILON) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return Math.max(EPSILON, factor * magnitude);
}

function stableNumber(value: number) {
  return Number(value.toPrecision(12)).toString();
}

function clampInteger(value: number, min: number, max: number) {
  return Math.round(clamp(Number.isFinite(value) ? value : min, min, max));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
