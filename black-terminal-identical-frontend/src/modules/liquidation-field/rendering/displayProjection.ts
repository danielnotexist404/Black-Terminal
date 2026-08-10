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
  devicePixelRatio?: number;
}

export interface BclifDisplayProjection {
  columns: number;
  rows: number;
  minPrice: number;
  maxPrice: number;
  priceStep: number;
  timeStepMs: number;
  intensity: Uint8Array;
  exposureHalf?: Uint16Array;
  confidence: Uint8Array;
  alpha: Uint8Array;
  validity: Uint8Array;
  yellowEligible: Uint8Array;
  rgba?: Uint8Array;
  safeRasterFinalVisiblePixels?: number;
  safeRasterExposureVisiblePixels?: number;
  safeRasterMinimumAlpha?: number;
  safeRasterMaximumAlpha?: number;
  yellowEligibleCells: number;
  historicalCells: number;
  liveCalibratedCells: number;
  missingCells: number;
  validCells: number;
  rawNonZeroCells: number;
  visibleCells: number;
  filteredCells: number;
  minimumVisibleAlpha: number;
  maximumAlpha: number;
  rawExposureMinimum: number;
  rawExposureMaximum: number;
  normalizedScalarMinimum: number;
  normalizedScalarMaximum: number;
  confidenceMinimum: number;
  confidenceMaximum: number;
  validityRatio: number;
  validModelRowsInDisplay: number;
  rowsClippedBelow: number;
  rowsClippedAbove: number;
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

/**
 * Identity of the immutable combined scalar field before display LOD, tone,
 * palette, confidence treatment, annotations, or camera projection. Keeping
 * this separate from the render hash makes presentation changes auditable.
 */
export function bclifScalarFieldHash(snapshot: LiquidationFieldSnapshot) {
  const combined = new Float32Array(snapshot.longExposure.length);
  for (let index = 0; index < combined.length; index += 1) {
    combined[index] = (snapshot.longExposure[index] ?? 0) + (snapshot.shortExposure[index] ?? 0);
  }
  let hash = fnvTextState(`${snapshot.header.rows}:${snapshot.header.columns}:${snapshot.header.startTime}:${snapshot.header.endTime}`);
  hash = fnvBuffer(combined, hash);
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
    renderer: settings.rendererVersion,
    authoritySemantics: settings.authoritySemantics,
    preset: settings.preset,
    viewMode: settings.viewMode,
    palette: settings.palette,
    opacity: settings.opacity,
    intensityGain: settings.intensityGain,
    thermalContrast: settings.thermalContrast,
    gamma: settings.gamma,
    lowQuantile: settings.lowQuantile,
    highQuantile: settings.highQuantile,
    sharpness: settings.sharpness,
    contextVisibilityFloor: settings.contextVisibilityFloor,
    clusterLabelFloor: settings.clusterLabelFloor,
    highAuthorityColorFloor: settings.highAuthorityColorFloor,
    strictHideBelowEnabled: settings.strictHideBelowEnabled,
    strictHideBelowConfidence: settings.strictHideBelowConfidence,
    historicalContextEnabled: settings.historicalContextEnabled,
    liveCalibratedEnabled: settings.liveCalibratedEnabled,
    priceDisplay: settings.priceDisplay,
    channel: settings.visualChannel,
    normalization: settings.thermalNormalization,
    confidenceWeightEnabled: settings.confidenceWeightEnabled,
    backgroundFloor: settings.backgroundFloor,
    plasmaBackgroundOpacity: settings.plasmaBackgroundOpacity,
    shelfContrast: settings.shelfContrast,
    residualShelfVisibility: settings.residualShelfVisibility,
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
    rawCohortShelvesVisible: settings.rawCohortShelvesVisible,
    compactBadgeVisible: settings.compactBadgeVisible,
    eventNodesVisible: settings.eventNodesVisible,
    shelfLabelsVisible: settings.shelfLabelsVisible,
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
  _snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  context: Pick<BclifDisplayContext, "plotWidth" | "plotHeight" | "constrainedTouchRenderer" | "devicePixelRatio">
) {
  const research = settings.priceDisplay === "FULL_MODEL_RANGE"
    || settings.preset === "FULL_SPECTRUM_RESEARCH" || settings.preset === "RESEARCH_DIAGNOSTICS"
    || settings.preset === "RAW_MODEL";
  const dpr = clamp(context.devicePixelRatio ?? 1, 1, 2);
  const physicalWidth = Math.max(1, context.plotWidth * dpr);
  const physicalHeight = Math.max(1, context.plotHeight * dpr);
  const focusMinimumRows = research ? 768 : 1_024;
  const focusMaximumRows = research ? 1_536 : 2_048;
  if (settings.adaptiveResolution === "LOW_PERFORMANCE" || context.constrainedTouchRenderer) return {
    rows: clamp(Math.round(physicalHeight * 0.75), 512, 768),
    columns: clamp(Math.round(physicalWidth * 0.75), 1_024, 2_048)
  };
  if (settings.adaptiveResolution === "ULTRA") return {
    rows: clamp(Math.round(physicalHeight), focusMinimumRows, focusMaximumRows),
    columns: clamp(Math.round(physicalWidth), 2_048, 4_096)
  };
  if (settings.adaptiveResolution === "HIGH") return {
    rows: clamp(Math.round(physicalHeight * 0.92), focusMinimumRows, focusMaximumRows),
    columns: clamp(Math.round(physicalWidth * 0.92), 1_536, 3_072)
  };
  if (settings.adaptiveResolution === "BALANCED") return {
    rows: clamp(Math.round(physicalHeight * 0.78), research ? 768 : 1_024, research ? 1_280 : 1_536),
    columns: clamp(Math.round(physicalWidth * 0.82), 1_024, 2_560)
  };
  return {
    rows: clamp(Math.round(physicalHeight * 0.88), focusMinimumRows, focusMaximumRows),
    columns: clamp(Math.round(physicalWidth * 0.90), 1_536, 4_096)
  };
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
  const confidenceBytes = new Uint8Array(cellCount);
  const validity = new Uint8Array(cellCount);
  const yellowEligible = new Uint8Array(cellCount);
  const raw = new Float32Array(cellCount);
  const modelNormalized = new Float32Array(cellCount);
  const confidence = new Float32Array(cellCount);
  const sourceIndices = new Uint32Array(cellCount);
  const globalRaw: number[] = [];
  const visibleRaw: number[] = [];
  const priceStep = (domain.maximum - domain.minimum) / Math.max(1, rows - 1);
  const timeStepMs = (snapshot.header.endTime - snapshot.header.startTime) / Math.max(1, columns - 1);
  const anchoredThermalIntensity = settings.rendererVersion === "REFERENCE_THERMAL_V2"
    ? buildAnchoredThermalIntensity(snapshot, settings)
    : null;

  const sourceRowMinimum = clamp(Math.floor((domain.minimum - snapshot.header.minPrice) / snapshot.header.priceStep), 0, sourceRows - 1);
  const sourceRowMaximum = clamp(Math.ceil((domain.maximum - snapshot.header.minPrice) / snapshot.header.priceStep), 0, sourceRows - 1);
  for (let sourceColumn = 0; sourceColumn < sourceColumns; sourceColumn++) {
    for (let sourceRow = 0; sourceRow < sourceRows; sourceRow++) {
      const sourceIndex = sourceColumn * sourceRows + sourceRow;
      if (!snapshot.validity[sourceIndex]) continue;
      const value = sourceValue(snapshot, settings, sourceIndex);
      if (Number.isFinite(value) && value > 0) globalRaw.push(value);
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
      const sample = resolveSourceSample(snapshot, settings, sourceColumn, sourcePosition, anchoredThermalIntensity);
      raw[targetIndex] = sample.raw;
      modelNormalized[targetIndex] = sample.normalized / 255;
      if (Number.isFinite(sample.raw) && sample.raw > 0) visibleRaw.push(sample.raw);
      confidence[targetIndex] = sample.confidence / 255;
      confidenceBytes[targetIndex] = Math.round(sample.confidence);
    }
  }

  globalRaw.sort((a, b) => a - b);
  visibleRaw.sort((a, b) => a - b);
  const globalLow = quantile(globalRaw, settings.lowQuantile);
  const globalHigh = Math.max(globalLow + Number.EPSILON, quantile(globalRaw, settings.highQuantile));
  const visibleLow = quantile(visibleRaw, settings.lowQuantile);
  const visibleHigh = Math.max(visibleLow + Number.EPSILON, quantile(visibleRaw, settings.highQuantile));
  const yellowThreshold = quantile(globalRaw, 1 - settings.yellowTailPercent / 100);
  const normalizeRaw = (value: number, low: number, high: number) => {
    if (!(value > 0) || !(high > low)) return 0;
    const lowLog = Math.log1p(Math.max(0, low));
    const span = Math.max(Number.EPSILON, Math.log1p(Math.max(0, high)) - lowLog);
    return clamp01((Math.log1p(value) - lowLog) / span);
  };
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
  let validCells = 0;
  let rawNonZeroCells = 0;
  let visibleCells = 0;
  let filteredCells = 0;
  let minimumVisibleAlpha = 255;
  let maximumAlpha = 0;

  for (let column = 0; column < columns; column++) {
    const live = column >= liveStartColumn;
    for (let row = 0; row < rows; row++) {
      const targetIndex = column * rows + row;
      if (!validity[targetIndex]) {
        alpha[targetIndex] = 255;
        missingCells += 1;
        continue;
      }
      validCells += 1;
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
      const rawValue = raw[targetIndex]!;
      const percentileNormalized = settings.rendererVersion === "REFERENCE_THERMAL_V2"
        && settings.viewMode !== "RAW_EXPOSURE";
      const globalUnit = percentileNormalized
        // The model intensity is expanding-horizon, causal, and anchored to
        // the immutable full price grid. Reusing it here keeps shelf colors
        // stable while the camera pans or zooms.
        ? modelNormalized[targetIndex]!
        : normalizeRaw(rawValue, globalLow, globalHigh);
      const visibleUnit = percentileNormalized
        ? normalizeEmpiricalRank(rawValue, visibleRaw, settings.lowQuantile, settings.highQuantile)
        : normalizeRaw(rawValue, visibleLow, visibleHigh);
      let unit = globalUnit;
      if (settings.viewMode === "VALIDITY_MASK") unit = 1;
      else if (settings.viewMode === "RAW_EXPOSURE") unit = globalUnit;
      else if (settings.thermalNormalization === "VISIBLE_FOCUS") unit = visibleUnit;
      else if (settings.thermalNormalization === "HYBRID") unit = globalUnit * 0.65 + visibleUnit * 0.35;
      else if (settings.thermalNormalization === "FIXED_ABSOLUTE") {
        unit = Math.min(1, Math.log1p(rawValue) / Math.log1p(1_000_000_000));
      } else if (settings.thermalNormalization === "OI_RELATIVE") {
        unit = globalUnit * Math.max(0.15, oiWeight);
      }
      if (settings.thermalNormalization === "CONFIDENCE_WEIGHTED" || settings.confidenceWeightEnabled) {
        unit *= 0.35 + confidence[targetIndex]! * 0.65;
      }
      unit = clamp01(unit);
      if (settings.rendererVersion === "LEGACY_RGBA_V1") {
        unit = Math.pow(unit, settings.gamma);
        unit = Math.pow(unit, 1 + settings.sharpness / 170);
        const contrast = settings.shelfContrast / 100;
        const contrastFloor = contrast * 0.05;
        unit = clamp01((unit - contrastFloor) / Math.max(1e-9, 1 - contrastFloor));
        unit = Math.pow(unit, 0.58 - contrast * 0.22);
      } else if (settings.viewMode !== "RAW_EXPOSURE" && settings.viewMode !== "VALIDITY_MASK"
        && settings.viewMode !== "ALPHA_OUTPUT") {
        unit = clamp01(unit * settings.intensityGain / 100);
        unit = clamp01(0.5 + (unit - 0.5) * settings.thermalContrast / 100);
        unit = unit * unit * (3 - 2 * unit);
        // V2 gamma follows photographic display semantics: values below one
        // deepen the plasma floor instead of bleaching most cells to yellow.
        unit = Math.pow(unit, 1 / Math.max(0.05, settings.gamma));
      }
      if (rawValue > 0) rawNonZeroCells += 1;
      const multipleEvidence = evidenceChannels >= 2;
      const yellow = confidencePercent >= settings.highAuthorityColorFloor
        && rawValue >= yellowThreshold
        && continuity >= 80
        && multipleEvidence
        && !browserHistorical;
      const modeledPeak = rawValue > 0
        && rawValue >= yellowThreshold
        && confidencePercent >= settings.contextVisibilityFloor;
      const historicalOnly = !live || evidenceClass === "OI_ONLY" || evidenceClass === "OI_PLUS_PRICE";
      let cap = 255;
      // Yellow eligibility remains strict evidence metadata. In the two
      // operational thermal themes, however, the rarest modeled relative peak
      // may use the visual endpoint while the HUD still states its authority.
      const relativePeakColor = modeledPeak
        && (settings.palette === "REFERENCE_THERMAL" || settings.palette === "BLACK_TERMINAL_BLOOD");
      if (!yellow && !relativePeakColor) cap = confidencePercent < 40 ? 155 : confidencePercent < 60 ? 214 : confidencePercent < 75 ? 232 : 244;
      let displayIntensity = Math.round(unit * 255);
      if (settings.rendererVersion === "LEGACY_RGBA_V1") {
        displayIntensity = clamp(Math.max(settings.backgroundFloor, displayIntensity), settings.backgroundFloor, cap);
      } else if (rawValue > 0) {
        // Preserve a distinguishable non-zero texel for every modeled shelf.
        // The purple floor is presentation-only and remains separate.
        displayIntensity = Math.max(Math.min(255, settings.backgroundFloor + 1), displayIntensity);
      }
      intensity[targetIndex] = displayIntensity;
      yellowEligible[targetIndex] = yellow ? 255 : 0;
      if (yellow) yellowEligibleCells += 1;

      const confidenceAuthority = confidencePercent < 40 ? 0.42
        : confidencePercent < 60 ? 0.68
          : confidencePercent < 75 ? 0.82
            : confidencePercent < 90 ? 0.92 : 1;
      const operationalThermalTheme = settings.palette === "REFERENCE_THERMAL"
        || settings.palette === "BLACK_TERMINAL_BLOOD";
      const visualAuthority = operationalThermalTheme
        ? Math.max(confidenceAuthority, 0.58 + unit * 0.42) : confidenceAuthority;
      let channelAlpha = live ? settings.liveCalibratedOpacity / 100 : settings.historicalContextOpacity / 100;
      if (!settings.historicalContextEnabled && !live) channelAlpha = 0;
      if (!settings.liveCalibratedEnabled && live) channelAlpha = 0;
      if (settings.visualChannel === "HISTORICAL_CONTEXT") channelAlpha = live ? 0.08 : settings.historicalContextOpacity / 100;
      if (settings.visualChannel === "LIVE_CALIBRATED") channelAlpha = live ? settings.liveCalibratedOpacity / 100 : 0;
      const contextFiltered = settings.rendererVersion === "LEGACY_RGBA_V1"
        && confidencePercent < settings.contextVisibilityFloor;
      const strictFiltered = settings.strictHideBelowEnabled
        && confidencePercent < settings.strictHideBelowConfidence;
      const cellAlpha = (settings.rendererVersion === "LEGACY_RGBA_V1" && rawValue <= 0) || contextFiltered || strictFiltered
        ? 0
        : settings.rendererVersion === "REFERENCE_THERMAL_V2"
          ? Math.round(255 * channelAlpha)
          : operationalThermalTheme
          // A thermal atlas is a color field, not a translucent line overlay.
          // Keep every still-live shelf opaque enough to retain its body and
          // use color (rather than vanishing alpha) for density. The residual
          // control governs the floor for partially mitigated mass; evidence
          // authority remains explicit in yellowEligible/HUD metadata.
          ? clamp(Math.max(
            Math.round(255 * channelAlpha * (0.96 + unit * 0.04)),
            Math.round((190 + settings.residualShelfVisibility * 0.85) * channelAlpha)
          ), 0, 255)
          : clamp(Math.max(
            Math.round(255 * visualAuthority * channelAlpha * (0.58 + unit * 0.42)),
            Math.round(
              255 * settings.residualShelfVisibility / 100
              * visualAuthority * channelAlpha
            )
          ), 0, 255);
      alpha[targetIndex] = cellAlpha;
      if (rawValue > 0 || settings.rendererVersion === "REFERENCE_THERMAL_V2") {
        if (cellAlpha > 0) {
          visibleCells += 1;
          minimumVisibleAlpha = Math.min(minimumVisibleAlpha, cellAlpha);
          maximumAlpha = Math.max(maximumAlpha, cellAlpha);
        } else filteredCells += 1;
      }

      if (live) liveCalibratedCells += 1;
      else historicalCells += 1;
    }
  }

  if (settings.rendererVersion === "LEGACY_RGBA_V1"
    && (settings.palette === "REFERENCE_THERMAL" || settings.palette === "BLACK_TERMINAL_BLOOD")) {
    applyBclifCausalShelfPersistence(
      intensity, alpha, rows, columns,
      0.99955 + settings.residualShelfVisibility / 100 * 0.00035,
      Math.round(214 - settings.shelfContrast * 0.1),
      Math.max(settings.backgroundFloor, 1),
      validity,
      !settings.strictHideBelowEnabled
    );
  }

  const modelHash = bclifModelHash(snapshot);
  const exposureHash = bclifExposureHash(snapshot);
  const renderSettingsHash = bclifRenderSettingsHash(settings);
  const displayRasterHash = bclifDisplayRasterIdentity(snapshot, settings, context);
  let normalizedScalarMinimum = 1;
  let normalizedScalarMaximum = 0;
  let confidenceMinimum = 1;
  let confidenceMaximum = 0;
  for (let index = 0; index < intensity.length; index += 1) {
    if (!validity[index]) continue;
    normalizedScalarMinimum = Math.min(normalizedScalarMinimum, intensity[index]! / 255);
    normalizedScalarMaximum = Math.max(normalizedScalarMaximum, intensity[index]! / 255);
    confidenceMinimum = Math.min(confidenceMinimum, confidenceBytes[index]! / 255);
    confidenceMaximum = Math.max(confidenceMaximum, confidenceBytes[index]! / 255);
  }

  return {
    columns,
    rows,
    minPrice: domain.minimum,
    maxPrice: domain.maximum,
    priceStep,
    timeStepMs,
    intensity,
    confidence: confidenceBytes,
    alpha,
    validity,
    yellowEligible,
    yellowEligibleCells,
    historicalCells,
    liveCalibratedCells,
    missingCells,
    validCells,
    rawNonZeroCells,
    visibleCells,
    filteredCells,
    minimumVisibleAlpha: visibleCells ? minimumVisibleAlpha : 0,
    maximumAlpha,
    rawExposureMinimum: visibleRaw.length ? visibleRaw[0]! : 0,
    rawExposureMaximum: visibleRaw.length ? visibleRaw.at(-1)! : 0,
    normalizedScalarMinimum: validCells ? normalizedScalarMinimum : 0,
    normalizedScalarMaximum: validCells ? normalizedScalarMaximum : 0,
    confidenceMinimum: validCells ? confidenceMinimum : 0,
    confidenceMaximum: validCells ? confidenceMaximum : 0,
    validityRatio: cellCount ? validCells / cellCount : 0,
    validModelRowsInDisplay: sourceRowMaximum - sourceRowMinimum + 1,
    rowsClippedBelow: sourceRowMinimum,
    rowsClippedAbove: Math.max(0, sourceRows - 1 - sourceRowMaximum),
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

function sourceValue(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  index: number
) {
  if (settings.viewMode === "VALIDITY_MASK") return snapshot.validity[index] ? 1 : 0;
  if (settings.viewMode === "CONFIDENCE_FIELD") return snapshot.confidence[index] ?? 0;
  if (settings.viewMode === "CONFIRMED_LIQUIDATIONS") return snapshot.confirmedNotional[index] ?? 0;
  if (settings.viewMode === "LONG_EXPOSURE") return snapshot.longExposure[index] ?? 0;
  if (settings.viewMode === "SHORT_EXPOSURE") return snapshot.shortExposure[index] ?? 0;
  return (snapshot.longExposure[index] ?? 0) + (snapshot.shortExposure[index] ?? 0);
}

function resolveSourceSample(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  column: number,
  rowPosition: number,
  anchoredThermalIntensity?: Uint8Array | null
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
  const raw = settings.viewMode === "VALIDITY_MASK" ? 1
    : settings.viewMode === "CONFIDENCE_FIELD" ? sample(snapshot.confidence)
      : settings.viewMode === "LONG_EXPOSURE" ? long
        : settings.viewMode === "SHORT_EXPOSURE" ? short
          : settings.viewMode === "CONFIRMED_LIQUIDATIONS" ? sample(snapshot.confirmedNotional)
            : long + short;
  const normalized = anchoredThermalIntensity ? sample(anchoredThermalIntensity)
    : settings.viewMode === "LONG_EXPOSURE" ? sample(snapshot.longNormalizedIntensity)
    : settings.viewMode === "SHORT_EXPOSURE" ? sample(snapshot.shortNormalizedIntensity)
      : settings.viewMode === "CONFIRMED_LIQUIDATIONS" ? sample(snapshot.confirmedIntensity)
        : settings.viewMode === "CONFIDENCE_FIELD" ? sample(snapshot.confidence)
          : sample(snapshot.normalizedIntensity);
  const confidence = sample(snapshot.confidence);
  return { raw, normalized, confidence };
}

/**
 * Maps each immutable model column by its cross-price exposure rank.
 *
 * BCLIF shelves are intentionally broad along the price axis. Subtracting a
 * local price mean therefore erases the signal and leaves only a purple
 * canvas. A within-column rank retains those broad shelves while reserving the
 * progressively rarer upper tail for cyan, green, and yellow. Each column is
 * evaluated independently, so neither later time columns nor camera geometry
 * can repaint an earlier shelf.
 */
function buildAnchoredThermalIntensity(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings
) {
  const { rows, columns } = snapshot.header;
  const selected = settings.viewMode === "LONG_EXPOSURE" ? snapshot.longExposure
    : settings.viewMode === "SHORT_EXPOSURE" ? snapshot.shortExposure
      : settings.viewMode === "CONFIRMED_LIQUIDATIONS" ? snapshot.confirmedNotional
        : null;
  if (settings.viewMode === "VALIDITY_MASK" || settings.viewMode === "CONFIDENCE_FIELD"
    || settings.viewMode === "RAW_EXPOSURE" || settings.viewMode === "ALPHA_OUTPUT") {
    return new Uint8Array(snapshot.normalizedIntensity);
  }
  const output = new Uint8Array(rows * columns);
  for (let column = 0; column < columns; column += 1) {
    const offset = column * rows;
    const columnExposure: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      const index = offset + row;
      if (!snapshot.validity[index]) continue;
      const value = selected
        ? selected[index] ?? 0
        : (snapshot.longExposure[index] ?? 0) + (snapshot.shortExposure[index] ?? 0);
      if (Number.isFinite(value) && value > 0) columnExposure.push(value);
    }
    columnExposure.sort((left, right) => left - right);
    for (let row = 0; row < rows; row += 1) {
      const index = offset + row;
      if (!snapshot.validity[index]) continue;
      const value = selected
        ? selected[index] ?? 0
        : (snapshot.longExposure[index] ?? 0) + (snapshot.shortExposure[index] ?? 0);
      const rank = normalizeEmpiricalRank(value, columnExposure, 0, 1);
      const unit = rank < 0.91
        ? 0.04 + rank / 0.91 * 0.51
        : rank < 0.97
          ? 0.58 + (rank - 0.91) / 0.06 * 0.21
          : rank < 0.998
            ? 0.80 + (rank - 0.97) / 0.028 * 0.15
            : 0.96 + (rank - 0.998) / 0.002 * 0.04;
      output[index] = Math.round(clamp01(unit) * 255);
    }
  }
  return output;
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

/**
 * Render-only, causal shelf retention. A high-energy shelf keeps its thermal
 * identity while the current model still reports non-zero mass on that price
 * row. Once the mass disappears (alpha=0), the retained visual state is reset
 * immediately. Iteration is strictly past-to-present, so a replay prefix can
 * never be repainted by a future shelf.
 */
export function applyBclifCausalShelfPersistence(
  intensity: Uint8Array,
  alpha: Uint8Array,
  rows: number,
  columns: number,
  retention: number,
  activationFloor = 196,
  continuationFloor = 18,
  validity?: Uint8Array,
  expandThermalBody = true
) {
  if (intensity.length !== rows * columns || alpha.length !== intensity.length
    || (validity && validity.length !== intensity.length)) {
    throw new Error("BCLIF_SHELF_PERSISTENCE_DIMENSIONS_INVALID");
  }
  const decay = clamp(retention, 0, 0.9999);
  const source = intensity.slice();
  const cores = new Uint8Array(intensity.length);
  const activationMask = selectBclifShelfActivations(source, alpha, rows, columns, activationFloor, 10);
  for (let row = 0; row < rows; row += 1) {
    let retained = 0;
    for (let column = 0; column < columns; column += 1) {
      const index = column * rows + row;
      const current = source[index]!;
      if (!alpha[index] || current < continuationFloor) {
        retained = 0;
        continue;
      }
      if (activationMask[index]) {
        retained = Math.max(current, activationMask[index]!, retained * decay);
      } else if (retained >= activationFloor * 0.34) {
        retained *= decay;
      } else {
        retained = 0;
      }
      if (retained > 0) cores[index] = Math.round(retained);
    }
  }

  // Preserve the continuous thermal body around each retained shelf, then
  // overlay a narrow high-DPI core. The wide Gaussian shoulder is what makes
  // low/medium/strong liquidity read as purple -> blue -> cyan -> green while
  // the inner core stays crystal sharp. This is visual resampling only: raw
  // exposure, validity, confidence and evidence authority are not mutated.
  const coreRadius = clamp(Math.round(rows / 300), 3, 5);
  const thermalRadius = clamp(Math.round(rows / 26), 18, 54);
  for (let column = 0; column < columns; column += 1) {
    const candidates: Array<{ row: number; value: number }> = [];
    for (let row = 0; row < rows; row += 1) {
      const value = cores[column * rows + row]!;
      if (value) candidates.push({ row, value });
    }
    candidates.sort((left, right) => right.value - left.value || left.row - right.row);
    const accepted: number[] = [];
    for (const candidate of candidates) {
      const shelfSeparation = Math.max(coreRadius * 2, Math.round(thermalRadius * 0.27));
      if (accepted.some((row) => Math.abs(row - candidate.row) <= shelfSeparation)) continue;
      const rankStrength = Math.max(0.58, 1 - accepted.length * 0.055);
      const shelfValue = Math.max(continuationFloor, Math.round(candidate.value * rankStrength));
      accepted.push(candidate.row);
      const sourceIndex = column * rows + candidate.row;
      const sourceAlpha = alpha[sourceIndex]!;
      if (expandThermalBody) {
        for (let offset = -thermalRadius; offset <= thermalRadius; offset += 1) {
          const targetRow = candidate.row + offset;
          if (targetRow < 0 || targetRow >= rows) continue;
          const targetIndex = column * rows + targetRow;
          if (validity && !validity[targetIndex]) continue;
          const distance = Math.abs(offset) / Math.max(1, thermalRadius);
          const falloff = Math.exp(-4.2 * distance * distance);
          const fieldValue = continuationFloor
            + (shelfValue - continuationFloor) * falloff * 0.72;
          intensity[targetIndex] = Math.max(intensity[targetIndex]!, Math.round(fieldValue));
          alpha[targetIndex] = Math.max(
            alpha[targetIndex]!,
            Math.round(sourceAlpha * (0.54 + falloff * 0.46))
          );
        }
      }
      for (let offset = -coreRadius; offset <= coreRadius; offset += 1) {
        const targetRow = candidate.row + offset;
        if (targetRow < 0 || targetRow >= rows) continue;
        const targetIndex = column * rows + targetRow;
        if (validity && !validity[targetIndex]) continue;
        if (!expandThermalBody && !alpha[targetIndex]) continue;
        const falloff = 1 - Math.abs(offset) / (coreRadius + 1) * 0.32;
        intensity[targetIndex] = Math.max(intensity[targetIndex]!, Math.round(shelfValue * falloff));
        alpha[targetIndex] = Math.max(alpha[targetIndex]!, Math.round(sourceAlpha * falloff));
      }
      if (accepted.length >= 10) break;
    }
  }
}

function selectBclifShelfActivations(
  intensity: Uint8Array,
  alpha: Uint8Array,
  rows: number,
  columns: number,
  activationFloor: number,
  maximumPerColumn: number
) {
  const selected = new Uint8Array(intensity.length);
  const offsets = [3, 7, 12];
  for (let column = 0; column < columns; column += 1) {
    const candidates: Array<{ row: number; value: number }> = [];
    for (let row = 0; row < rows; row += 1) {
      const index = column * rows + row;
      const value = intensity[index]!;
      if (!alpha[index] || value < activationFloor) continue;
      const localPeak = offsets.every((offset) => {
        const lower = Math.max(0, row - offset);
        const upper = Math.min(rows - 1, row + offset);
        return value >= intensity[column * rows + lower]!
          && value >= intensity[column * rows + upper]!;
      });
      if (localPeak) candidates.push({ row, value });
    }
    candidates.sort((left, right) => right.value - left.value || left.row - right.row);
    const accepted: number[] = [];
    const priceQuantum = clamp(Math.round(rows / 150), 4, 10);
    for (const candidate of candidates) {
      const snappedRow = clamp(Math.round(candidate.row / priceQuantum) * priceQuantum, 0, rows - 1);
      if (accepted.some((row) => Math.abs(row - snappedRow) <= 10)) continue;
      selected[column * rows + snappedRow] = Math.max(selected[column * rows + snappedRow]!, candidate.value);
      accepted.push(snappedRow);
      if (accepted.length >= maximumPerColumn) break;
    }
  }
  return selected;
}

function quantile(sorted: readonly number[], q: number) {
  if (!sorted.length) return 0;
  const position = clamp01(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function normalizeEmpiricalRank(
  value: number,
  sorted: readonly number[],
  lowQuantile: number,
  highQuantile: number
) {
  if (!(value > 0) || !sorted.length) return 0;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  const rank = sorted.length === 1 ? 1 : low / (sorted.length - 1);
  const span = Math.max(1e-6, highQuantile - lowQuantile);
  return clamp01((rank - lowQuantile) / span);
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

export function bclifUint8ToHalf(values: Uint8Array) {
  const result = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index += 1) result[index] = floatToHalf(values[index]! / 255);
  return result;
}

function floatToHalf(value: number) {
  const bits = new Uint32Array(1);
  const floats = new Float32Array(bits.buffer);
  floats[0] = value;
  const raw = bits[0]!;
  const sign = (raw >> 16) & 0x8000;
  const exponent = ((raw >> 23) & 0xff) - 127 + 15;
  const mantissa = raw & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const shifted = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((shifted + 0x1000) >> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}
