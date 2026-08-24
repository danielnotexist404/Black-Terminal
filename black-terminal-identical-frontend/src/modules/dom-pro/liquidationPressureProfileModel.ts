import { priceToScreenY, type ChartPriceTransformSnapshot } from "../../chart-engine/priceTransform.ts";
import type { LiquidationFieldSnapshot } from "../liquidation-field/core/types.ts";

export type LiquidationPressureSide = "long" | "short" | "mixed" | "empty";

export type LiquidationPressureProfileRow = {
  key: string;
  index: number;
  top: number;
  height: number;
  price: number;
  priceHigh: number;
  priceLow: number;
  longExposure: number;
  shortExposure: number;
  totalExposure: number;
  confirmedNotional: number;
  confirmedCount: number;
  confidence: number;
  intensity: number;
  side: LiquidationPressureSide;
  isCurrentPrice: boolean;
  isHeavy: boolean;
  isExtreme: boolean;
  sourceRows: number;
};

export type LiquidationPressureProfileModel = {
  viewportRevision: number;
  rows: LiquidationPressureProfileRow[];
  plotTop: number;
  plotBottom: number;
  currentPrice: number | null;
  currentPriceY: number | null;
  priceMin: number;
  priceMax: number;
  priceSpan: number;
  priceStep: number;
  priceDecimals: number;
  longExposureTotal: number;
  shortExposureTotal: number;
  totalExposure: number;
  noiseFloor: number;
  heavyThreshold: number;
  extremeThreshold: number;
  visibleSourceRows: number;
  hiddenAboveCount: number;
  hiddenBelowCount: number;
  latestColumn: number;
  latestTimestamp: number;
  authority: LiquidationFieldSnapshot["authority"];
  certainty: LiquidationFieldSnapshot["certainty"];
};

export type CumulativeLiquidationPressurePoint = {
  rowIndex: number;
  cumulativeExposure: number;
  ratio: number;
};

type BuildLiquidationPressureProfileInput = {
  snapshot: LiquidationFieldSnapshot;
  viewport: ChartPriceTransformSnapshot;
  currentPrice: number;
  maximumRows?: number;
};

const EPSILON = 1e-12;

/**
 * Fits the price camera to the immutable absolute BCLIF price lattice. This is
 * deliberately separate from the live DOM book-fit operation: it exposes the
 * modeled liquidation envelope, not venue order-book coverage.
 */
export function fitViewportToLiquidationProfile(
  viewport: ChartPriceTransformSnapshot,
  snapshot: LiquidationFieldSnapshot
): ChartPriceTransformSnapshot {
  const minimum = Math.max(EPSILON, snapshot.header.minPrice - snapshot.header.priceStep / 2);
  const maximum = snapshot.header.maxPrice + snapshot.header.priceStep / 2;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return viewport;
  return { ...viewport, priceMin: minimum, priceMax: maximum };
}

/**
 * Projects the latest causal BCLIF exposure column onto a stable, price-anchored
 * ladder. Long exposure means positions expected to liquidate on a downward
 * move (forced-sell pressure); short exposure means positions expected to
 * liquidate on an upward move (forced-buy pressure).
 */
export function buildLiquidationPressureProfile(
  input: BuildLiquidationPressureProfileInput
): LiquidationPressureProfileModel {
  const { snapshot, viewport } = input;
  const sourceRows = snapshot.header.rows;
  const sourceColumns = snapshot.header.columns;
  const sourceStep = snapshot.header.priceStep;
  if (sourceRows < 1 || sourceColumns < 1 || !(sourceStep > 0)) {
    return emptyModel(input);
  }

  const latestColumn = resolveLatestValidColumn(snapshot);
  if (latestColumn < 0) return emptyModel(input);
  const maximumRows = clampInteger(input.maximumRows ?? 180, 8, 720);
  const firstVisibleSourceRow = clampInteger(
    Math.ceil((viewport.priceMin - snapshot.header.minPrice) / sourceStep - 0.5),
    0,
    sourceRows - 1
  );
  const lastVisibleSourceRow = clampInteger(
    Math.floor((viewport.priceMax - snapshot.header.minPrice) / sourceStep + 0.5),
    0,
    sourceRows - 1
  );
  const visibleSourceRows = Math.max(0, lastVisibleSourceRow - firstVisibleSourceRow + 1);
  const compression = Math.max(1, Math.ceil(visibleSourceRows / maximumRows));
  const firstGroup = Math.floor(firstVisibleSourceRow / compression);
  const lastGroup = Math.floor(lastVisibleSourceRow / compression);
  const rows: LiquidationPressureProfileRow[] = [];

  for (let group = lastGroup; group >= firstGroup; group -= 1) {
    const groupSourceLow = Math.max(0, group * compression);
    const groupSourceHigh = Math.min(sourceRows - 1, groupSourceLow + compression - 1);
    const priceLow = Math.max(EPSILON, snapshot.header.minPrice + (groupSourceLow - 0.5) * sourceStep);
    const priceHigh = snapshot.header.minPrice + (groupSourceHigh + 0.5) * sourceStep;
    if (priceHigh < viewport.priceMin || priceLow > viewport.priceMax) continue;
    const highY = priceToScreenY(priceHigh, viewport);
    const lowY = priceToScreenY(priceLow, viewport);
    if (highY === null || lowY === null) continue;
    const top = Math.max(viewport.plotTop, Math.min(highY, lowY));
    const bottom = Math.min(viewport.plotBottom, Math.max(highY, lowY));
    if (bottom - top <= EPSILON) continue;

    let longExposure = 0;
    let shortExposure = 0;
    let confirmedNotional = 0;
    let confirmedCount = 0;
    let weightedConfidence = 0;
    let confidenceWeight = 0;
    let validSourceRows = 0;
    for (let sourceRow = groupSourceLow; sourceRow <= groupSourceHigh; sourceRow += 1) {
      const sourceIndex = latestColumn * sourceRows + sourceRow;
      if ((snapshot.validity[sourceIndex] ?? 0) <= 0) continue;
      const sourceLong = Math.max(0, snapshot.longExposure[sourceIndex] ?? 0);
      const sourceShort = Math.max(0, snapshot.shortExposure[sourceIndex] ?? 0);
      const exposure = sourceLong + sourceShort;
      longExposure += sourceLong;
      shortExposure += sourceShort;
      confirmedNotional += Math.max(0, snapshot.confirmedNotional[sourceIndex] ?? 0);
      confirmedCount += Math.max(0, snapshot.confirmedCount[sourceIndex] ?? 0);
      weightedConfidence += ((snapshot.confidence[sourceIndex] ?? 0) / 2.55) * Math.max(exposure, 1);
      confidenceWeight += Math.max(exposure, 1);
      validSourceRows += 1;
    }

    const totalExposure = longExposure + shortExposure;
    rows.push({
      key: `${snapshot.header.gridVersion ?? snapshot.header.modelVersion}:${latestColumn}:${group}`,
      index: rows.length,
      top,
      height: bottom - top,
      price: (priceLow + priceHigh) / 2,
      priceHigh,
      priceLow,
      longExposure,
      shortExposure,
      totalExposure,
      confirmedNotional,
      confirmedCount,
      confidence: confidenceWeight > 0 ? weightedConfidence / confidenceWeight : 0,
      intensity: 0,
      side: classifyPressureSide(longExposure, shortExposure),
      isCurrentPrice: input.currentPrice >= priceLow && input.currentPrice <= priceHigh,
      isHeavy: false,
      isExtreme: false,
      sourceRows: validSourceRows
    });
  }

  const distribution = pressureDistribution(rows.map((row) => row.totalExposure).filter((value) => value > EPSILON));
  for (const row of rows) {
    row.intensity = resolvePressureSignificance(row.totalExposure, distribution.noiseFloor, distribution.extremeThreshold);
    row.isHeavy = row.totalExposure >= distribution.heavyThreshold && row.totalExposure > EPSILON;
    row.isExtreme = row.totalExposure >= distribution.extremeThreshold && row.totalExposure > EPSILON;
  }

  const currentPriceY = priceToScreenY(input.currentPrice, viewport);
  return {
    viewportRevision: viewport.revision,
    rows,
    plotTop: viewport.plotTop,
    plotBottom: viewport.plotBottom,
    currentPrice: Number.isFinite(input.currentPrice) && input.currentPrice > 0 ? input.currentPrice : null,
    currentPriceY: currentPriceY !== null && currentPriceY >= viewport.plotTop && currentPriceY <= viewport.plotBottom
      ? currentPriceY
      : null,
    priceMin: viewport.priceMin,
    priceMax: viewport.priceMax,
    priceSpan: viewport.priceMax - viewport.priceMin,
    priceStep: sourceStep * compression,
    priceDecimals: decimalsForStep(sourceStep * compression),
    longExposureTotal: rows.reduce((sum, row) => sum + row.longExposure, 0),
    shortExposureTotal: rows.reduce((sum, row) => sum + row.shortExposure, 0),
    totalExposure: rows.reduce((sum, row) => sum + row.totalExposure, 0),
    noiseFloor: distribution.noiseFloor,
    heavyThreshold: distribution.heavyThreshold,
    extremeThreshold: distribution.extremeThreshold,
    visibleSourceRows,
    hiddenAboveCount: Math.max(0, sourceRows - 1 - lastVisibleSourceRow),
    hiddenBelowCount: Math.max(0, firstVisibleSourceRow),
    latestColumn,
    latestTimestamp: snapshot.timestamps[latestColumn] ?? snapshot.generatedAt,
    authority: snapshot.authority,
    certainty: snapshot.certainty
  };
}

export function resolvePressureSignificance(value: number, noiseFloor: number, extremeThreshold: number) {
  if (!Number.isFinite(value) || value <= EPSILON) return 0;
  const logged = Math.log1p(value);
  const loggedFloor = Math.log1p(Math.max(0, noiseFloor));
  const loggedExtreme = Math.max(loggedFloor + EPSILON, Math.log1p(Math.max(noiseFloor, extremeThreshold)));
  if (value < noiseFloor && noiseFloor > EPSILON) {
    return clamp(0.045 * (value / noiseFloor) ** 1.5, 0.002, 0.045);
  }
  const normalized = clamp((logged - loggedFloor) / (loggedExtreme - loggedFloor), 0, 1);
  return clamp(0.1 + 0.9 * normalized ** 0.72, 0.1, 1);
}

/**
 * Builds the two causal legs of the LPP V field from current price outward.
 * Long-position exposure is accumulated only below market (forced sells) and
 * short-position exposure only above market (forced buys). The result is a
 * normalized display envelope; it never changes or invents modeled notional.
 */
export function buildCumulativeLiquidationPressureBand(
  model: LiquidationPressureProfileModel,
  side: "long" | "short",
  exposureByRow?: readonly number[]
): CumulativeLiquidationPressurePoint[] {
  if (model.currentPriceY === null || model.rows.length < 2) return [];
  const currentIndex = model.rows.findIndex((row) => row.isCurrentPrice);
  if (currentIndex < 0) return [];
  const rowIndices = side === "short"
    ? Array.from({ length: currentIndex }, (_, offset) => currentIndex - offset - 1)
    : Array.from({ length: model.rows.length - currentIndex - 1 }, (_, offset) => currentIndex + offset + 1);
  const exposureFor = (rowIndex: number) => exposureByRow?.[rowIndex] ?? (side === "long"
    ? model.rows[rowIndex]?.longExposure ?? 0
    : model.rows[rowIndex]?.shortExposure ?? 0);
  const total = rowIndices.reduce((sum, rowIndex) => sum + Math.max(0, exposureFor(rowIndex)), 0);
  if (total <= EPSILON) return [];
  let cumulativeExposure = 0;
  return [
    { rowIndex: currentIndex, cumulativeExposure: 0, ratio: 0 },
    ...rowIndices.map((rowIndex) => {
      cumulativeExposure += Math.max(0, exposureFor(rowIndex));
      return { rowIndex, cumulativeExposure, ratio: clamp(cumulativeExposure / total, 0, 1) };
    })
  ];
}

/**
 * Expands statistically meaningful local nodes without allowing a tiny
 * minority side in a mixed row to inherit the dominant side's full width.
 */
export function resolveLiquidationNodeWidthRatio(
  intensity: number,
  sideShare: number,
  isHeavy: boolean,
  isExtreme: boolean
) {
  const boundedIntensity = clamp(intensity, 0, 1);
  const boundedShare = clamp(sideShare, 0, 1);
  if (boundedIntensity <= EPSILON || boundedShare <= EPSILON) return 0;
  const continuousWidth = boundedIntensity ** 1.38 * boundedShare ** 0.7;
  const significanceFloor = (isExtreme ? 0.96 : isHeavy ? 0.72 : 0) * boundedShare ** 0.58;
  return clamp(Math.max(continuousWidth, significanceFloor), 0, 1);
}

function resolveLatestValidColumn(snapshot: LiquidationFieldSnapshot) {
  for (let column = snapshot.header.columns - 1; column >= 0; column -= 1) {
    const start = column * snapshot.header.rows;
    const end = start + snapshot.header.rows;
    for (let index = start; index < end; index += 1) {
      if ((snapshot.validity[index] ?? 0) > 0) return column;
    }
  }
  return -1;
}

function classifyPressureSide(longExposure: number, shortExposure: number): LiquidationPressureSide {
  if (longExposure <= EPSILON && shortExposure <= EPSILON) return "empty";
  if (longExposure > shortExposure * 1.08) return "long";
  if (shortExposure > longExposure * 1.08) return "short";
  return "mixed";
}

function pressureDistribution(values: number[]) {
  if (!values.length) return { noiseFloor: 0, heavyThreshold: 1, extremeThreshold: 1 };
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    noiseFloor: percentile(sorted, 0.65),
    heavyThreshold: percentile(sorted, 0.88),
    extremeThreshold: Math.max(percentile(sorted, 0.98), percentile(sorted, 0.88) * 1.08)
  };
}

function percentile(sorted: number[], fraction: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function decimalsForStep(step: number) {
  if (!(step > 0)) return 2;
  if (step >= 100) return 0;
  if (step >= 1) return 1;
  return Math.min(8, Math.max(2, Math.ceil(-Math.log10(step)) + 1));
}

function emptyModel(input: BuildLiquidationPressureProfileInput): LiquidationPressureProfileModel {
  return {
    viewportRevision: input.viewport.revision,
    rows: [],
    plotTop: input.viewport.plotTop,
    plotBottom: input.viewport.plotBottom,
    currentPrice: input.currentPrice > 0 ? input.currentPrice : null,
    currentPriceY: null,
    priceMin: input.viewport.priceMin,
    priceMax: input.viewport.priceMax,
    priceSpan: input.viewport.priceMax - input.viewport.priceMin,
    priceStep: input.snapshot.header.priceStep,
    priceDecimals: decimalsForStep(input.snapshot.header.priceStep),
    longExposureTotal: 0,
    shortExposureTotal: 0,
    totalExposure: 0,
    noiseFloor: 0,
    heavyThreshold: 1,
    extremeThreshold: 1,
    visibleSourceRows: 0,
    hiddenAboveCount: 0,
    hiddenBelowCount: 0,
    latestColumn: -1,
    latestTimestamp: 0,
    authority: input.snapshot.authority,
    certainty: input.snapshot.certainty
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.round(clamp(value, minimum, maximum));
}
