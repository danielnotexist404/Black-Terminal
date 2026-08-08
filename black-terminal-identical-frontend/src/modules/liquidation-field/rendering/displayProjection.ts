import {
  extractBclifOperationalClusters
} from "../core/operationalClusters.ts";
import type { BclifEvidenceClass, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types.ts";

export interface BclifDisplayContext {
  chartPriceMinimum: number;
  chartPriceMaximum: number;
  currentPrice: number;
  plotWidth: number;
  plotHeight: number;
  constrainedTouchRenderer: boolean;
}

export interface BclifDisplayProjection {
  columns: number;
  rows: number;
  minPrice: number;
  maxPrice: number;
  priceStep: number;
  timeStepMs: number;
  intensity: Uint8Array;
  alpha: Uint8Array;
  validity: Uint8Array;
  yellowEligible: Uint8Array;
  rgba?: Uint8Array;
  yellowEligibleCells: number;
  historicalCells: number;
  liveCalibratedCells: number;
  missingCells: number;
  evidenceCounts: Record<BclifEvidenceClass, number>;
  liveCalibrationStartTime: number | null;
  modelHash: string;
  exposureHash: string;
  renderSettingsHash: string;
  displayRasterHash: string;
}

export function bclifModelHash(snapshot: LiquidationFieldSnapshot) {
  return fnvText(JSON.stringify({
    version: snapshot.header.modelVersion,
    venue: snapshot.header.venue,
    symbol: snapshot.header.symbol,
    horizon: snapshot.header.horizon,
    start: snapshot.header.startTime,
    end: snapshot.header.endTime,
    min: snapshot.header.minPrice,
    max: snapshot.header.maxPrice,
    gridOrigin: snapshot.header.gridOrigin ?? null,
    gridVersion: snapshot.header.gridVersion ?? null,
    rows: snapshot.header.rows,
    columns: snapshot.header.columns,
    cohorts: snapshot.cohorts.map((cohort) => [
      cohort.id, cohort.side, cohort.createdAt, cohort.updatedAt, cohort.sourceIntervalStart,
      cohort.sourceIntervalEnd, cohort.entryMean, cohort.entryDistribution.hash, cohort.leverageMean,
      cohort.initialOpenMass, cohort.remainingMass, cohort.massUnit,
      cohort.estimatedRemainingNotional, cohort.liquidationMean, cohort.liquidationStdDev,
      cohort.survivalProbability, cohort.posteriorWeight, cohort.confidence, cohort.state,
      cohort.fundingAdjustmentBps, cohort.lastLifecycleEvent?.id ?? null
    ]),
    massLedger: snapshot.massLedger
  }));
}

export function bclifExposureHash(snapshot: LiquidationFieldSnapshot) {
  let hash = fnvTextState(`${snapshot.header.checksum}:${snapshot.header.rows}:${snapshot.header.columns}`);
  hash = fnvBuffer(snapshot.longExposure, hash);
  hash = fnvBuffer(snapshot.shortExposure, hash);
  hash = fnvBuffer(snapshot.validity, hash);
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

export function bclifDisplayEvidenceHash(snapshot: LiquidationFieldSnapshot) {
  let hash = fnvTextState(JSON.stringify({
    authority: snapshot.authority,
    certainty: snapshot.certainty,
    sourceCutoffTimestamp: snapshot.header.sourceCutoffTimestamp ?? null,
    coverage: snapshot.coverage,
    persistentCoverage: snapshot.persistentCoverage ?? null,
    confidenceBreakdown: snapshot.confidenceBreakdown
  }));
  hash = fnvBuffer(snapshot.confidence, hash);
  hash = fnvBuffer(snapshot.confirmedIntensity, hash);
  hash = fnvBuffer(snapshot.confirmedNotional, hash);
  hash = fnvBuffer(snapshot.confirmedCount, hash);
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

export function bclifRenderSettingsHash(settings: LiquidationFieldSettings) {
  return fnvText(JSON.stringify({
    preset: settings.preset,
    viewMode: settings.viewMode,
    palette: settings.palette,
    opacity: settings.opacity,
    gamma: settings.gamma,
    lowQuantile: settings.lowQuantile,
    highQuantile: settings.highQuantile,
    sharpness: settings.sharpness,
    confidence: settings.minimumConfidence,
    priceDisplay: settings.priceDisplay,
    channel: settings.visualChannel,
    normalization: settings.thermalNormalization,
    confidenceWeightEnabled: settings.confidenceWeightEnabled,
    backgroundFloor: settings.backgroundFloor,
    yellowTailPercent: settings.yellowTailPercent,
    historicalContextOpacity: settings.historicalContextOpacity,
    liveCalibratedOpacity: settings.liveCalibratedOpacity,
    requireMultipleEvidenceChannels: settings.requireMultipleEvidenceChannels,
    adaptiveResolution: settings.adaptiveResolution,
    customPriceMinimum: settings.customPriceMinimum,
    customPriceMaximum: settings.customPriceMaximum,
    autoFocusMarginPercent: settings.autoFocusMarginPercent,
    sideFilter: settings.sideFilter,
    uncertaintyEnvelopesVisible: settings.uncertaintyEnvelopesVisible,
    focusBand: settings.focusBand,
    customFocusBandPercent: settings.customFocusBandPercent,
    candlePalette: settings.candlePalette,
    candleContrast: settings.candleContrast,
    maximumClusterLabels: settings.maximumClusterLabels,
    operationalSummaryVisible: settings.operationalSummaryVisible,
    collectionStartMarkerVisible: settings.collectionStartMarkerVisible,
    cohortProvenanceVisible: settings.cohortProvenanceVisible,
    cohortBirthMarkersVisible: settings.cohortBirthMarkersVisible,
    legendVisible: settings.legendVisible,
    diagnosticsVisible: settings.diagnosticsVisible,
    confirmedMarkersVisible: settings.confirmedMarkersVisible,
    cascadePathsVisible: settings.cascadePathsVisible
  }));
}

export function bclifDisplayRasterIdentity(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  context: BclifDisplayContext
) {
  const domain = resolveBclifDisplayDomain(snapshot, settings, context);
  if (!domain) return "NONE";
  const dimensions = resolveBclifDisplayDimensions(snapshot, settings, context);
  return fnvText([
    bclifExposureHash(snapshot), bclifDisplayEvidenceHash(snapshot), bclifRenderSettingsHash(settings),
    domain.minimum, domain.maximum, dimensions.rows, dimensions.columns,
    Math.round(context.currentPrice / Math.max(snapshot.header.priceStep, 1e-8))
  ].join(":"));
}

export function resolveBclifDisplayDomain(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  context: Pick<BclifDisplayContext, "chartPriceMinimum" | "chartPriceMaximum" | "currentPrice">
) {
  const modelMinimum = snapshot.header.minPrice;
  const modelMaximum = snapshot.header.maxPrice;
  let minimum = context.chartPriceMinimum;
  let maximum = context.chartPriceMaximum;
  const percent = settings.priceDisplay === "CURRENT_PRICE_5" ? 5
    : settings.priceDisplay === "CURRENT_PRICE_10" ? 10
      : settings.priceDisplay === "CURRENT_PRICE_20" ? 20
        : settings.priceDisplay === "CURRENT_PRICE_40" ? 40 : null;
  if (percent !== null) {
    minimum = context.currentPrice * (1 - percent / 100);
    maximum = context.currentPrice * (1 + percent / 100);
  } else if (settings.priceDisplay === "FULL_MODEL_RANGE") {
    minimum = modelMinimum;
    maximum = modelMaximum;
  } else if (settings.priceDisplay === "CUSTOM") {
    minimum = settings.customPriceMinimum;
    maximum = settings.customPriceMaximum;
  } else if (settings.priceDisplay === "AUTO_FOCUS") {
    const clusters = extractBclifOperationalClusters(snapshot, context.currentPrice, settings);
    const nearestAbove = clusters.filter((cluster) => cluster.peakPrice > context.currentPrice).sort((a, b) => a.peakPrice - b.peakPrice)[0];
    const nearestBelow = clusters.filter((cluster) => cluster.peakPrice < context.currentPrice).sort((a, b) => b.peakPrice - a.peakPrice)[0];
    minimum = Math.min(minimum, nearestBelow?.priceLow ?? context.currentPrice);
    maximum = Math.max(maximum, nearestAbove?.priceHigh ?? context.currentPrice);
    const margin = (maximum - minimum) * settings.autoFocusMarginPercent / 100;
    minimum -= margin;
    maximum += margin;
  }
  minimum = Math.max(modelMinimum, minimum);
  maximum = Math.min(modelMaximum, maximum);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return null;
  return { minimum, maximum };
}

export function resolveBclifDisplayDimensions(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  context: Pick<BclifDisplayContext, "plotWidth" | "plotHeight" | "constrainedTouchRenderer">
) {
  const research = settings.priceDisplay === "FULL_MODEL_RANGE" || settings.preset === "FULL_SPECTRUM_RESEARCH" || settings.preset === "RAW_MODEL";
  const fallback = settings.adaptiveResolution === "LOW_PERFORMANCE" || context.constrainedTouchRenderer;
  let rows: number;
  if (fallback) rows = research ? 384 : 512;
  else if (settings.adaptiveResolution === "HIGH") rows = research ? 1024 : 2048;
  else if (settings.adaptiveResolution === "BALANCED") rows = research ? 768 : 1024;
  else rows = research
    ? clamp(Math.round(context.plotHeight * 0.72), 512, 1024)
    : clamp(Math.round(context.plotHeight * 1.18), 768, 2048);
  const columns = fallback
    ? Math.min(snapshot.header.columns, 512)
    : Math.min(snapshot.header.columns, clamp(Math.round(context.plotWidth), 512, 1536));
  return { rows, columns };
}

export function buildBclifDisplayProjection(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  context: BclifDisplayContext
): BclifDisplayProjection | null {
  const domain = resolveBclifDisplayDomain(snapshot, settings, context);
  if (!domain) return null;
  const dimensions = resolveBclifDisplayDimensions(snapshot, settings, context);
  const { rows: sourceRows, columns: sourceColumns } = snapshot.header;
  const rows = dimensions.rows;
  const columns = dimensions.columns;
  const cellCount = rows * columns;
  const intensity = new Uint8Array(cellCount);
  const alpha = new Uint8Array(cellCount);
  const validity = new Uint8Array(cellCount);
  const yellowEligible = new Uint8Array(cellCount);
  const raw = new Float32Array(cellCount);
  const global = new Float32Array(cellCount);
  const confidence = new Float32Array(cellCount);
  const sourceIndices = new Uint32Array(cellCount);
  const validRaw: number[] = [];
  const priceStep = (domain.maximum - domain.minimum) / Math.max(1, rows - 1);
  const timeStepMs = (snapshot.header.endTime - snapshot.header.startTime) / Math.max(1, columns - 1);

  const sourceRowMinimum = clamp(Math.floor((domain.minimum - snapshot.header.minPrice) / snapshot.header.priceStep), 0, sourceRows - 1);
  const sourceRowMaximum = clamp(Math.ceil((domain.maximum - snapshot.header.minPrice) / snapshot.header.priceStep), 0, sourceRows - 1);
  for (let sourceColumn = 0; sourceColumn < sourceColumns; sourceColumn++) {
    for (let sourceRow = sourceRowMinimum; sourceRow <= sourceRowMaximum; sourceRow++) {
      const sourceIndex = sourceColumn * sourceRows + sourceRow;
      if (!snapshot.validity[sourceIndex]) continue;
      const value = settings.viewMode === "LONG_EXPOSURE" ? snapshot.longExposure[sourceIndex]!
        : settings.viewMode === "SHORT_EXPOSURE" ? snapshot.shortExposure[sourceIndex]!
          : settings.viewMode === "CONFIRMED_LIQUIDATIONS" ? snapshot.confirmedNotional[sourceIndex]!
            : snapshot.longExposure[sourceIndex]! + snapshot.shortExposure[sourceIndex]!;
      if (value > 0) validRaw.push(value);
    }
  }

  for (let column = 0; column < columns; column++) {
    const sourceColumn = Math.round(column / Math.max(1, columns - 1) * (sourceColumns - 1));
    for (let row = 0; row < rows; row++) {
      const price = domain.minimum + row * priceStep;
      const sourcePosition = (price - snapshot.header.minPrice) / snapshot.header.priceStep;
      const sourceRow = clamp(Math.round(sourcePosition), 0, sourceRows - 1);
      const sourceIndex = sourceColumn * sourceRows + sourceRow;
      const targetIndex = column * rows + row;
      sourceIndices[targetIndex] = sourceIndex;
      const valid = snapshot.validity[sourceIndex] ?? 0;
      validity[targetIndex] = valid;
      if (!valid) continue;
      const sample = resolveSourceSample(snapshot, settings, sourceColumn, sourcePosition);
      raw[targetIndex] = sample.raw;
      global[targetIndex] = sample.normalized / 255;
      confidence[targetIndex] = sample.confidence / 255;
    }
  }

  validRaw.sort((a, b) => a - b);
  const low = quantile(validRaw, settings.lowQuantile);
  const high = Math.max(low + Number.EPSILON, quantile(validRaw, settings.highQuantile));
  const yellowThreshold = quantile(validRaw, 1 - settings.yellowTailPercent / 100);
  const persistent = snapshot.persistentCoverage;
  const tradeCoverage = (persistent?.tradeCoveragePercent ?? snapshot.coverage.observedTradeCoveragePercent) ?? 0;
  const eventCoverage = (persistent?.liquidationCoveragePercent ?? snapshot.coverage.liquidationEventCoveragePercent) ?? 0;
  const bookCoverage = (persistent?.orderbookCoveragePercent ?? snapshot.coverage.orderbookCoveragePercent) ?? 0;
  const continuity = (persistent?.continuityPercent ?? snapshot.coverage.modelContinuityPercent) ?? 0;
  const liveCoverage = snapshot.authority === "PERSISTENT_NODE"
    ? Math.max(tradeCoverage, eventCoverage, bookCoverage)
    : Math.max(eventCoverage, bookCoverage);
  const liveColumns = Math.min(columns, Math.ceil(columns * liveCoverage / 100));
  const liveStartColumn = liveColumns > 0 ? columns - liveColumns : columns;
  const oiWeight = Math.max(0, Math.min(1, ((persistent?.openInterestCoveragePercent ?? snapshot.coverage.openInterestCoveragePercent) ?? 0) / 100));
  const tradeWeight = Math.max(0, Math.min(1, tradeCoverage / 100));
  const eventWeight = Math.max(0, Math.min(1, eventCoverage / 100));
  const bookWeight = Math.max(0, Math.min(1, bookCoverage / 100));
  const fundingWeight = Math.max(0, Math.min(1, ((persistent?.fundingCoveragePercent ?? 0) ?? 0) / 100));
  const positioningWeight = Math.max(0, Math.min(1, snapshot.confidenceBreakdown.entryPrice / 100));
  const logLow = Math.log1p(low);
  const logSpan = Math.max(Number.EPSILON, Math.log1p(high) - logLow);
  const evidenceCounts: Record<BclifEvidenceClass, number> = {
    OI_ONLY: 0,
    OI_PLUS_PRICE: 0,
    OI_PLUS_TRADES: 0,
    OI_PLUS_TRADES_PLUS_LIQUIDATIONS: 0,
    OI_PLUS_TRADES_PLUS_BOOK: 0,
    FULL_CONTEXT: 0
  };
  let historicalCells = 0;
  let liveCalibratedCells = 0;
  let missingCells = 0;
  let yellowEligibleCells = 0;

  for (let column = 0; column < columns; column++) {
    const live = column >= liveStartColumn;
    for (let row = 0; row < rows; row++) {
      const targetIndex = column * rows + row;
      if (!validity[targetIndex]) {
        alpha[targetIndex] = 255;
        missingCells += 1;
        continue;
      }
      const sourceIndex = sourceIndices[targetIndex]!;
      const browserHistorical = !live && snapshot.authority === "BROWSER_FALLBACK";
      const cellTrade = browserHistorical ? 0 : tradeWeight;
      const cellEvent = browserHistorical ? 0 : Math.max(eventWeight, (snapshot.confirmedIntensity[sourceIndex] ?? 0) / 255);
      const cellBook = browserHistorical ? 0 : bookWeight;
      const cellFunding = browserHistorical ? 0 : fundingWeight;
      const evidenceClass = evidenceClassFor(oiWeight, cellTrade, cellEvent, cellBook, cellFunding, positioningWeight);
      evidenceCounts[evidenceClass] += 1;
      const evidenceChannels = Number(oiWeight >= 0.35) + Number(cellTrade >= 0.35) + Number(cellEvent >= 0.35)
        + Number(cellBook >= 0.35) + Number(cellFunding >= 0.35);
      const confidencePercent = confidence[targetIndex]! * 100;
      const visibleUnit = high > low ? clamp01((Math.log1p(raw[targetIndex]!) - logLow) / logSpan) : 0;
      let unit = global[targetIndex]!;
      if (settings.thermalNormalization === "VISIBLE_FOCUS") unit = visibleUnit;
      else if (settings.thermalNormalization === "HYBRID") unit = unit * 0.68 + visibleUnit * 0.32;
      else if (settings.thermalNormalization === "FIXED_ABSOLUTE") unit = Math.min(1, Math.log1p(raw[targetIndex]!) / Math.log1p(1_000_000_000));
      else if (settings.thermalNormalization === "OI_RELATIVE") unit = unit * Math.max(0.15, oiWeight);
      if (settings.thermalNormalization === "CONFIDENCE_WEIGHTED" || settings.confidenceWeightEnabled) {
        unit *= 0.35 + confidence[targetIndex]! * 0.65;
      }
      unit = Math.pow(clamp01(unit), settings.gamma);
      unit = Math.pow(unit, 1 + settings.sharpness / 170);

      const multipleEvidence = evidenceChannels >= 2;
      const yellow = confidencePercent >= 75
        && raw[targetIndex]! >= yellowThreshold
        && continuity >= 80
        && multipleEvidence;
      const historicalOnly = !live || evidenceClass === "OI_ONLY" || evidenceClass === "OI_PLUS_PRICE";
      let cap = 255;
      if (!yellow) cap = confidencePercent < 40 ? 108 : confidencePercent < 60 ? 145 : confidencePercent < 75 ? 190 : 232;
      if (historicalOnly) cap = Math.min(cap, 176);
      if (settings.requireMultipleEvidenceChannels && !multipleEvidence) cap = Math.min(cap, 168);
      let displayIntensity = Math.round(unit * 255);
      displayIntensity = clamp(Math.max(settings.backgroundFloor, displayIntensity), settings.backgroundFloor, cap);
      intensity[targetIndex] = displayIntensity;
      yellowEligible[targetIndex] = yellow ? 255 : 0;
      if (yellow) yellowEligibleCells += 1;

      const confidenceAuthority = confidencePercent < 40 ? 0.12
        : confidencePercent < 60 ? 0.3
          : confidencePercent < 75 ? 0.58
            : confidencePercent < 90 ? 0.82 : 1;
      let channelAlpha = live ? settings.liveCalibratedOpacity / 100 : settings.historicalContextOpacity / 100;
      if (settings.visualChannel === "HISTORICAL_CONTEXT") channelAlpha = live ? 0.08 : settings.historicalContextOpacity / 100;
      if (settings.visualChannel === "LIVE_CALIBRATED") channelAlpha = live ? settings.liveCalibratedOpacity / 100 : 0;
      if (confidencePercent < settings.minimumConfidence) {
        channelAlpha *= settings.preset === "HIGH_CONFIDENCE" ? 0 : 0.2;
      }
      if (settings.requireMultipleEvidenceChannels && !multipleEvidence) channelAlpha *= 0.55;
      alpha[targetIndex] = clamp(Math.round(255 * confidenceAuthority * channelAlpha), 0, 255);
      if (live) liveCalibratedCells += 1;
      else historicalCells += 1;
    }
  }

  const modelHash = bclifModelHash(snapshot);
  const exposureHash = bclifExposureHash(snapshot);
  const renderSettingsHash = bclifRenderSettingsHash(settings);
  const displayRasterHash = bclifDisplayRasterIdentity(snapshot, settings, context);

  return {
    columns,
    rows,
    minPrice: domain.minimum,
    maxPrice: domain.maximum,
    priceStep,
    timeStepMs,
    intensity,
    alpha,
    validity,
    yellowEligible,
    yellowEligibleCells,
    historicalCells,
    liveCalibratedCells,
    missingCells,
    evidenceCounts,
    liveCalibrationStartTime: liveStartColumn < columns
      ? snapshot.header.startTime + liveStartColumn / Math.max(1, columns - 1) * (snapshot.header.endTime - snapshot.header.startTime)
      : null,
    modelHash,
    exposureHash,
    renderSettingsHash,
    displayRasterHash
  };
}

function resolveSourceSample(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  column: number,
  rowPosition: number
) {
  const rows = snapshot.header.rows;
  const lower = clamp(Math.floor(rowPosition), 0, rows - 1);
  const upper = clamp(lower + 1, 0, rows - 1);
  const fraction = clamp01(rowPosition - lower);
  const sample = (values: ArrayLike<number>) => {
    const left = values[column * rows + lower] ?? 0;
    const right = values[column * rows + upper] ?? left;
    return left + (right - left) * fraction;
  };
  const long = sample(snapshot.longExposure);
  const short = sample(snapshot.shortExposure);
  const raw = settings.viewMode === "LONG_EXPOSURE" ? long
    : settings.viewMode === "SHORT_EXPOSURE" ? short
      : settings.viewMode === "CONFIRMED_LIQUIDATIONS" ? sample(snapshot.confirmedNotional)
        : long + short;
  const normalized = settings.viewMode === "LONG_EXPOSURE" ? sample(snapshot.longNormalizedIntensity)
    : settings.viewMode === "SHORT_EXPOSURE" ? sample(snapshot.shortNormalizedIntensity)
      : settings.viewMode === "CONFIRMED_LIQUIDATIONS" ? sample(snapshot.confirmedIntensity)
        : settings.viewMode === "CONFIDENCE_FIELD" ? sample(snapshot.confidence)
          : sample(snapshot.normalizedIntensity);
  const confidence = sample(snapshot.confidence);
  return { raw, normalized, confidence };
}

function evidenceClassFor(
  openInterest: number,
  trades: number,
  events: number,
  orderBook: number,
  funding: number,
  positioning: number
): BclifEvidenceClass {
  if (trades >= 0.35 && events >= 0.05 && orderBook >= 0.35 && funding >= 0.35 && positioning >= 0.2) return "FULL_CONTEXT";
  if (trades >= 0.35 && events >= 0.05) return "OI_PLUS_TRADES_PLUS_LIQUIDATIONS";
  if (trades >= 0.35 && orderBook >= 0.35) return "OI_PLUS_TRADES_PLUS_BOOK";
  if (trades >= 0.35) return "OI_PLUS_TRADES";
  if (openInterest >= 0.01) return "OI_PLUS_PRICE";
  return "OI_ONLY";
}

function quantile(sorted: readonly number[], q: number) {
  if (!sorted.length) return 0;
  const position = clamp01(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function fnvText(value: string, seed = 0x811c9dc5) {
  const hash = fnvTextState(value, seed);
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

function fnvTextState(value: string, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function fnvBuffer(value: ArrayBufferView, seed: number | string = 0x811c9dc5) {
  let hash = typeof seed === "string" ? Number.parseInt(seed.slice(-8), 16) >>> 0 : seed >>> 0;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}
