import type { LiquidationFieldSettings } from "./types.ts";

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const t = position - lower;
  return (sorted[lower] ?? 0) * (1 - t) + (sorted[upper] ?? 0) * t;
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
    const value = Math.log1p(exposure[index]!);
    if (Number.isFinite(value)) logValues.push(value);
  }
  logValues.sort((a, b) => a - b);
  const low = quantile(logValues, settings.lowQuantile);
  const high = Math.max(low + 1e-6, quantile(logValues, settings.highQuantile));
  const normalized = new Uint8Array(exposure.length);
  for (let index = 0; index < exposure.length; index++) {
    if (!validity[index] || exposure[index]! <= 0) continue;
    const raw = Math.max(0, Math.min(1, (Math.log1p(exposure[index]!) - low) / (high - low)));
    const confidenceWeight = settings.scale === "CONFIDENCE_WEIGHTED_LOG"
      ? Math.max(0, Math.min(1, confidence[index]! / 255))
      : 1;
    normalized[index] = Math.round(255 * Math.pow(raw * confidenceWeight, settings.gamma));
  }
  return { normalized, low, high };
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
  for (let index = 0; index < kernel.length; index++) kernel[index] /= total;
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
      for (let offset = -timeRadius; offset <= timeRadius; offset++) {
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
