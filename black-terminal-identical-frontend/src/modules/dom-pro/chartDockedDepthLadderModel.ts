import { priceToScreenY, screenYToPrice, type ChartPriceTransformSnapshot } from "../../chart-engine/priceTransform.ts";
import type { ProfessionalDomLadderModel, ProfessionalDomSide } from "./domProfessionalLadder";
import type { WallDetection } from "./types";

export type ChartDockedDepthCoverage = "live" | "unavailable";
export type ChartDockedDepthScaleMode = "follow" | "book" | "locked";

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

const EPSILON = 1e-12;
export const CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD = 26_000;

export function buildChartDockedDepthLadder(input: ChartDockedDepthLadderInput): ChartDockedDepthLadderModel {
  const { depth } = input;
  const scaleMode = input.scaleMode ?? "follow";
  const viewport = scaleMode === "book" ? fitViewportToDeliveredBook(input.viewport, depth) : input.viewport;
  const plotHeight = Math.max(0, viewport.plotBottom - viewport.plotTop);
  const preferredRowHeight = clamp(input.preferredRowHeight ?? 13, 9, 24);
  const rowCount = plotHeight > 0
    ? clampInteger(Math.floor(plotHeight / preferredRowHeight), 8, input.maximumRows ?? 180)
    : 0;
  const rowHeight = rowCount > 0 ? plotHeight / rowCount : preferredRowHeight;
  const rows: MutableRow[] = [];

  for (let index = 0; index < rowCount; index += 1) {
    const top = viewport.plotTop + index * rowHeight;
    const bottom = index === rowCount - 1 ? viewport.plotBottom : top + rowHeight;
    const priceHigh = finitePrice(screenYToPrice(top, viewport));
    const priceLow = finitePrice(screenYToPrice(bottom, viewport));
    const price = finitePrice(screenYToPrice((top + bottom) / 2, viewport));
    const coverage = depth.coverageMin !== null && depth.coverageMax !== null
      && priceHigh >= depth.coverageMin && priceLow <= depth.coverageMax
      ? "live"
      : "unavailable";
    rows.push({
      key: `${viewport.revision}:${index}`,
      index,
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
    const index = clampInteger(Math.floor((y - viewport.plotTop) / Math.max(rowHeight, EPSILON)), 0, Math.max(0, rows.length - 1));
    const target = rows[index];
    if (!target) continue;
    target.bidSize += source.bidSize;
    target.askSize += source.askSize;
    target.delta += source.delta;
    target.coverage = "live";
    if (source.wall && (!target.wall || source.wall.score > target.wall.score)) target.wall = source.wall;
  }

  const currentY = depth.currentPrice === null ? null : priceToScreenY(depth.currentPrice, viewport);
  const currentIndex = currentY === null || rows.length === 0
    ? -1
    : clampInteger(Math.floor((currentY - viewport.plotTop) / Math.max(rowHeight, EPSILON)), 0, rows.length - 1);
  if (currentY !== null && currentY >= viewport.plotTop && currentY <= viewport.plotBottom && currentIndex >= 0) {
    rows[currentIndex].isCurrentPrice = true;
  }

  const nonZeroDepth = rows
    .map((row) => Math.max(row.bidSize, row.askSize))
    .filter((value) => value > EPSILON);
  const depthReference = percentile(nonZeroDepth, 0.95);
  rows.forEach((row) => {
    row.totalSize = row.bidSize + row.askSize;
    row.signedSize = row.bidSize - row.askSize;
    row.side = classifySide(row.bidSize, row.askSize);
    row.depthRatio = row.totalSize > EPSILON
      ? clamp(Math.sqrt(Math.max(row.bidSize, row.askSize) / Math.max(depthReference, EPSILON)), 0.025, 1)
      : 0;
    const relativeDelta = row.totalSize > EPSILON
      ? Math.abs(row.delta) / Math.max(row.totalSize, Math.abs(row.delta), EPSILON)
      : 0;
    row.activityRatio = clamp(Math.sqrt(relativeDelta), 0, 1);
  });

  let askCumulative = 0;
  const askStart = currentIndex >= 0 ? currentIndex : rows.length - 1;
  for (let index = askStart; index >= 0; index -= 1) {
    askCumulative += rows[index].askSize;
    rows[index].askCumulative = askCumulative;
  }
  let bidCumulative = 0;
  const bidStart = currentIndex >= 0 ? currentIndex : 0;
  for (let index = bidStart; index < rows.length; index += 1) {
    bidCumulative += rows[index].bidSize;
    rows[index].bidCumulative = bidCumulative;
  }

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

function finitePrice(value: number | null) {
  return value !== null && Number.isFinite(value) ? value : 0;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.round(clamp(Number.isFinite(value) ? value : min, min, max));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
