import type { LiquidationFieldSettings } from "../core/types.ts";
import type { BclifDisplayProjection } from "./displayProjection.ts";
import { bclifThermalBackdropStyle, createThermalPalette } from "./thermalPalette.ts";

export interface BclifSafeThermalRasterMetrics {
  finalVisiblePixels: number;
  exposureVisiblePixels: number;
  minimumAlpha: number;
  maximumAlpha: number;
  rgbaBytes: number;
}

export interface BclifSafeThermalRaster {
  rgba: Uint8Array;
  metrics: BclifSafeThermalRasterMetrics;
}

/**
 * Browser-compatible final compositing plane for Reference Thermal V2.
 *
 * This is deliberately generated from the same full-resolution scalar
 * projection as the shader path. It never invents exposure, never applies a
 * confidence mask, and never represents shelves with annotations. Valid
 * zero-exposure cells receive only the configured purple presentation floor;
 * non-zero model cells retain a guaranteed visible alpha.
 */
export function buildBclifSafeThermalRaster(
  projection: BclifDisplayProjection,
  settings: LiquidationFieldSettings,
  reuse?: Uint8Array | null
): BclifSafeThermalRaster {
  const { columns, rows } = projection;
  const required = columns * rows * 4;
  const rgba = reuse?.length === required ? reuse : new Uint8Array(required);
  const palette = createThermalPalette(settings.palette);
  const invalid = bclifThermalBackdropStyle(settings.palette).invalid;
  // Keep a non-zero emergency visibility floor while still honoring the
  // user's opacity control across its useful range. The production default
  // remains 96%; only deliberately low opacity values reach this floor.
  const opacityFloor = Math.max(46, Math.round(settings.opacity / 100 * 255));
  let finalVisiblePixels = 0;
  let exposureVisiblePixels = 0;
  let minimumAlpha = 255;
  let maximumAlpha = 0;

  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const sourceIndex = column * rows + row;
      const targetIndex = ((rows - 1 - row) * columns + column) * 4;
      if (!projection.validity[sourceIndex]) {
        rgba[targetIndex] = (invalid >> 16) & 0xff;
        rgba[targetIndex + 1] = (invalid >> 8) & 0xff;
        rgba[targetIndex + 2] = invalid & 0xff;
        rgba[targetIndex + 3] = 255;
        continue;
      }

      const scalar = projection.intensity[sourceIndex]!;
      const alpha = opacityFloor;
      if (settings.viewMode === "RAW_EXPOSURE") {
        rgba[targetIndex] = scalar;
        rgba[targetIndex + 1] = scalar;
        rgba[targetIndex + 2] = scalar;
      } else if (settings.viewMode === "CONFIDENCE_FIELD") {
        const confidence = projection.confidence[sourceIndex]!;
        rgba[targetIndex] = confidence;
        rgba[targetIndex + 1] = confidence;
        rgba[targetIndex + 2] = confidence;
      } else if (settings.viewMode === "VALIDITY_MASK") {
        rgba[targetIndex] = 255;
        rgba[targetIndex + 1] = 255;
        rgba[targetIndex + 2] = 255;
      } else if (settings.viewMode === "ALPHA_OUTPUT") {
        const outputAlpha = projection.alpha[sourceIndex]!;
        rgba[targetIndex] = outputAlpha;
        rgba[targetIndex + 1] = outputAlpha;
        rgba[targetIndex + 2] = outputAlpha;
      } else {
        const shelfOnly = settings.viewMode === "SHELF_LINES_ONLY";
        const paletteIndex = shelfOnly && scalar < 160
          ? Math.max(1, Math.round(settings.backgroundFloor * 0.35))
          : Math.max(settings.backgroundFloor, scalar);
        const offset = Math.min(255, paletteIndex) * 4;
        rgba[targetIndex] = palette[offset]!;
        rgba[targetIndex + 1] = palette[offset + 1]!;
        rgba[targetIndex + 2] = palette[offset + 2]!;
      }
      rgba[targetIndex + 3] = alpha;
      finalVisiblePixels += 1;
      if (scalar > 0) exposureVisiblePixels += 1;
      minimumAlpha = Math.min(minimumAlpha, alpha);
      maximumAlpha = Math.max(maximumAlpha, alpha);
    }
  }

  return {
    rgba,
    metrics: {
      finalVisiblePixels,
      exposureVisiblePixels,
      minimumAlpha: finalVisiblePixels ? minimumAlpha : 0,
      maximumAlpha,
      rgbaBytes: rgba.byteLength
    }
  };
}
