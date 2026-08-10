import type { LiquidationFieldSettings } from "../core/types.ts";
import type { BclifDisplayProjection } from "./displayProjection.ts";
import { createThermalPalette } from "./thermalPalette.ts";

export interface BclifReferenceThermalFieldMetrics {
  validCellCount: number;
  invalidCellCount: number;
  nonZeroCellCount: number;
  zeroExposureValidCellCount: number;
  intensityQuantiles: {
    p05: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p99: number;
    p9986: number;
  };
  thermalOccupancyPercent: {
    deepPurple: number;
    blueCyan: number;
    green: number;
    yellow: number;
  };
  meanPaletteLuminance: number;
  hsvValueQuantiles: { p10: number; p50: number; p90: number; maximum: number };
  brightShelfOccupancyPercent: number;
}

/**
 * Measures the scalar field before candles, indicators, or chart chrome are
 * composited. These values are deliberately derived from the uploaded scalar
 * projection, not from a screenshot, so a visually attractive candle or HUD
 * cannot make a weak/empty heat field pass certification.
 */
export function measureBclifReferenceThermalField(
  projection: BclifDisplayProjection,
  settings: LiquidationFieldSettings
): BclifReferenceThermalFieldMetrics {
  const values: number[] = [];
  const paletteValues: number[] = [];
  const palette = createThermalPalette(settings.palette);
  let invalidCellCount = 0;
  let nonZeroCellCount = 0;
  let zeroExposureValidCellCount = 0;
  let deepPurple = 0;
  let blueCyan = 0;
  let green = 0;
  let yellow = 0;
  let brightShelves = 0;
  let luminanceTotal = 0;

  for (let index = 0; index < projection.intensity.length; index += 1) {
    if (!projection.validity[index]) {
      invalidCellCount += 1;
      continue;
    }
    const rawValue = projection.intensity[index]!;
    const value = Math.max(rawValue, settings.backgroundFloor);
    values.push(value);
    if (rawValue > 0) nonZeroCellCount += 1;
    else zeroExposureValidCellCount += 1;
    const unit = value / 255;
    if (unit < 0.55) deepPurple += 1;
    else if (unit < 0.865) blueCyan += 1;
    else if (unit < 0.992) green += 1;
    else yellow += 1;
    const offset = value * 4;
    const red = palette[offset]! / 255;
    const greenChannel = palette[offset + 1]! / 255;
    const blue = palette[offset + 2]! / 255;
    const luminance = 0.2126 * red + 0.7152 * greenChannel + 0.0722 * blue;
    luminanceTotal += luminance;
    paletteValues.push(Math.max(red, greenChannel, blue) * settings.opacity / 100);
    if (unit >= 0.90 && luminance >= 0.36) brightShelves += 1;
  }

  values.sort((left, right) => left - right);
  paletteValues.sort((left, right) => left - right);
  const validCellCount = values.length;
  const percentile = (value: number) => validCellCount
    ? values[Math.min(validCellCount - 1, Math.floor((validCellCount - 1) * value))]! / 255
    : 0;
  const percent = (count: number) => validCellCount ? count / validCellCount * 100 : 0;
  const valuePercentile = (value: number) => validCellCount
    ? paletteValues[Math.min(validCellCount - 1, Math.floor((validCellCount - 1) * value))]!
    : 0;
  return {
    validCellCount,
    invalidCellCount,
    nonZeroCellCount,
    zeroExposureValidCellCount,
    intensityQuantiles: {
      p05: percentile(0.05),
      p25: percentile(0.25),
      p50: percentile(0.50),
      p75: percentile(0.75),
      p90: percentile(0.90),
      p99: percentile(0.99),
      p9986: percentile(0.9986)
    },
    thermalOccupancyPercent: {
      deepPurple: percent(deepPurple),
      blueCyan: percent(blueCyan),
      green: percent(green),
      yellow: percent(yellow)
    },
    meanPaletteLuminance: validCellCount ? luminanceTotal / validCellCount : 0,
    hsvValueQuantiles: {
      p10: valuePercentile(0.10),
      p50: valuePercentile(0.50),
      p90: valuePercentile(0.90),
      maximum: valuePercentile(1)
    },
    brightShelfOccupancyPercent: percent(brightShelves)
  };
}
