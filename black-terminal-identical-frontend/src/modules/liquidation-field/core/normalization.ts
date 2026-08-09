import type { LiquidationFieldSettings } from "./types.ts";

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const t = position - lower;
  return (sorted[lower] ?? 0) * (1 - t) + (sorted[upper] ?? 0) * t;
}

function confidenceAdjustedLogExposure(
  exposure: number,
  confidence: number,
  settings: LiquidationFieldSettings
) {
  const confidenceWeight = settings.scale === "CONFIDENCE_WEIGHTED_LOG"
    ? Math.max(0, Math.min(1, confidence / 255))
    : 1;
  return Math.log1p(Math.max(0, exposure) * confidenceWeight);
}

export function normalizeExposure(
  exposure: Float32Array,
  confidence: Uint8Array,
  validity: Uint8Array,
  settings: LiquidationFieldSettings
) {
  const logValues: number[] = [];
  for (let index = 0; index < exposure.length; index++) {
    if (!validity[index] || exposure[index]! <= 0) continue;
    const value = confidenceAdjustedLogExposure(exposure[index]!, confidence[index]!, settings);
    if (Number.isFinite(value) && value > 0) logValues.push(value);
  }
  logValues.sort((a, b) => a - b);
  const low = quantile(logValues, settings.lowQuantile);
  const high = Math.max(low + 1e-6, quantile(logValues, settings.highQuantile));
  const normalized = new Uint8Array(exposure.length);
  for (let index = 0; index < exposure.length; index++) {
    if (!validity[index] || exposure[index]! <= 0) continue;
    const adjusted = confidenceAdjustedLogExposure(exposure[index]!, confidence[index]!, settings);
    const raw = Math.max(0, Math.min(1, (adjusted - low) / (high - low)));
    normalized[index] = Math.round(255 * Math.pow(raw, settings.gamma));
  }
  return { normalized, low, high };
}

/**
 * Chronological normalization for a time × price field. Every output column
 * is scaled only with values available in that column and its trailing
 * window, so appending future frames cannot repaint finalized history.
 */
export function normalizeExposureCausal(
  exposure: Float32Array,
  confidence: Uint8Array,
  validity: Uint8Array,
  columns: number,
  rows: number,
  settings: LiquidationFieldSettings,
  trailingColumns = 1
) {
  if (exposure.length !== columns * rows || confidence.length !== exposure.length || validity.length !== exposure.length) {
    throw new Error("BCLIF causal normalization dimensions do not match");
  }
  const normalized = new Uint8Array(exposure.length);
  const lows = new Float32Array(columns);
  const highs = new Float32Array(columns);
  let lastLow = 0;
  let lastHigh = 1e-6;
  const windowSize = Math.max(1, Math.min(columns, Math.round(trailingColumns)));
  // Fixed-domain log histograms preserve causal rolling quantiles without
  // repeatedly sorting up to 64 complete price columns. The domain covers
  // log1p notionals far beyond the model's bounded USD mass.
  const histogramBins = 4_096;
  const maximumLogExposure = 40;
  const windowHistogram = new Uint32Array(histogramBins);
  const queuedColumns: Uint16Array[] = [];
  let windowPopulation = 0;

  for (let column = 0; column < columns; column++) {
    const columnHistogram = new Uint16Array(histogramBins);
    const start = column * rows;
    for (let row = 0; row < rows; row++) {
      const index = start + row;
      if (!validity[index] || exposure[index]! <= 0) continue;
      const value = confidenceAdjustedLogExposure(exposure[index]!, confidence[index]!, settings);
      if (!Number.isFinite(value) || value <= 0) continue;
      const bin = Math.max(0, Math.min(histogramBins - 1,
        Math.floor(value / maximumLogExposure * (histogramBins - 1))));
      columnHistogram[bin] = Math.min(65_535, columnHistogram[bin]! + 1);
      windowHistogram[bin] = windowHistogram[bin]! + 1;
      windowPopulation += 1;
    }
    queuedColumns.push(columnHistogram);
    if (queuedColumns.length > windowSize) {
      const expired = queuedColumns.shift()!;
      for (let bin = 0; bin < histogramBins; bin++) {
        const count = expired[bin]!;
        if (!count) continue;
        windowHistogram[bin] = windowHistogram[bin]! - count;
        windowPopulation -= count;
      }
    }
    if (windowPopulation > 0) {
      lastLow = histogramQuantile(windowHistogram, windowPopulation, settings.lowQuantile, maximumLogExposure);
      lastHigh = Math.max(lastLow + 1e-6,
        histogramQuantile(windowHistogram, windowPopulation, settings.highQuantile, maximumLogExposure));
    }
    lows[column] = lastLow;
    highs[column] = lastHigh;
    for (let row = 0; row < rows; row++) {
      const index = start + row;
      if (!validity[index] || exposure[index]! <= 0) continue;
      const adjusted = confidenceAdjustedLogExposure(exposure[index]!, confidence[index]!, settings);
      const raw = Math.max(0, Math.min(1, (adjusted - lastLow) / Math.max(1e-6, lastHigh - lastLow)));
      normalized[index] = Math.round(255 * Math.pow(raw, settings.gamma));
    }
  }
  return { normalized, lows, highs, low: lows.at(-1) ?? 0, high: highs.at(-1) ?? 1e-6 };
}

/**
 * Causal expanding-horizon normalization. Unlike a short rolling or
 * per-column percentile, the evidence domain can only grow. A local generation
 * therefore cannot manufacture a fresh yellow maximum simply because older
 * context rolled out of a 64-column window.
 */
export function normalizeExposureExpanding(
  exposure: Float32Array,
  confidence: Uint8Array,
  validity: Uint8Array,
  columns: number,
  rows: number,
  settings: LiquidationFieldSettings
) {
  return normalizeExposureCausal(exposure, confidence, validity, columns, rows, settings, columns);
}

function histogramQuantile(
  histogram: Uint32Array,
  population: number,
  quantileValue: number,
  maximum: number
) {
  const target = Math.max(0, Math.min(population - 1, quantileValue * (population - 1)));
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    cumulative += histogram[bin]!;
    if (cumulative > target) return (bin + 0.5) / histogram.length * maximum;
  }
  return maximum;
}

function gaussianKernel(sigma: number) {
  if (sigma <= 0.01) return new Float32Array([1]);
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = weight;
    total += weight;
  }
  for (let index = 0; index < kernel.length; index++) kernel[index] = (kernel[index] ?? 0) / total;
  return kernel;
}

export function smoothField(
  source: Float32Array,
  validity: Uint8Array,
  columns: number,
  rows: number,
  timeSigma: number,
  priceSigma: number
) {
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  const timeKernel = gaussianKernel(timeSigma);
  const priceKernel = gaussianKernel(priceSigma);
  const timeRadius = Math.floor(timeKernel.length / 2);
  const priceRadius = Math.floor(priceKernel.length / 2);

  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const index = column * rows + row;
      if (!validity[index]) continue;
      let weighted = 0;
      let total = 0;
      // Causal/trailing kernel: a historical column never reads future state.
      for (let offset = -timeRadius; offset <= 0; offset++) {
        const targetColumn = column + offset;
        if (targetColumn < 0 || targetColumn >= columns) continue;
        const targetIndex = targetColumn * rows + row;
        if (!validity[targetIndex]) continue;
        const weight = timeKernel[offset + timeRadius]!;
        weighted += source[targetIndex]! * weight;
        total += weight;
      }
      horizontal[index] = total > 0 ? weighted / total : source[index]!;
    }
  }

  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const index = column * rows + row;
      if (!validity[index]) continue;
      let weighted = 0;
      let total = 0;
      for (let offset = -priceRadius; offset <= priceRadius; offset++) {
        const targetRow = row + offset;
        if (targetRow < 0 || targetRow >= rows) continue;
        const targetIndex = column * rows + targetRow;
        if (!validity[targetIndex]) continue;
        const weight = priceKernel[offset + priceRadius]!;
        weighted += horizontal[targetIndex]! * weight;
        total += weight;
      }
      result[index] = total > 0 ? weighted / total : horizontal[index]!;
    }
  }
  return result;
}
