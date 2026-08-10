import type { LiquidationFieldPalette, LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types.ts";
import { BCLIF_REFERENCE_LUT_RGB, BCLIF_REFERENCE_LUT_SOURCE_SHA256 } from "./referenceThermalLut.generated.ts";

type PaletteStop = readonly [number, string];

const REFERENCE_STOPS: readonly PaletteStop[] = [
  [0.00, "#350044"], [0.12, "#4a0c69"], [0.28, "#403075"], [0.46, "#275f89"],
  [0.64, "#1f9580"], [0.82, "#4fbd5d"], [0.94, "#a8d22f"], [1.00, "#f0e705"]
];

const PALETTES: Record<LiquidationFieldPalette, readonly PaletteStop[]> = {
  REFERENCE_THERMAL: REFERENCE_STOPS,
  BLACK_TERMINAL_BLOOD: [
    [0, "#030205"], [0.08, "#120207"], [0.24, "#2b030c"], [0.44, "#540616"],
    [0.64, "#88091f"], [0.80, "#bd1029"], [0.92, "#ed3347"], [0.98, "#f5aeb8"], [1, "#ffffff"]
  ],
  INSTITUTIONAL_MONOCHROME: [
    [0, "#030405"], [0.16, "#111316"], [0.38, "#292d31"], [0.62, "#5d6268"],
    [0.82, "#aeb2b7"], [1, "#ffffff"]
  ],
  DIRECTIONAL_SPLIT: [
    [0, "#090311"], [0.18, "#2c0a35"], [0.42, "#5f0b28"], [0.65, "#a20d25"],
    [0.84, "#e23342"], [1, "#fff3f5"]
  ],
  CONFIDENCE: [
    [0, "#08050c"], [0.20, "#261434"], [0.45, "#46396a"], [0.68, "#67769a"],
    [0.86, "#aeb9c8"], [1, "#ffffff"]
  ]
};

function parseHex(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255] as const;
}

function srgbToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const normalized = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(normalized * 255)));
}

export interface BclifThermalBackdropStyle {
  top: number;
  middle: number;
  bottom: number;
  invalid: number;
}

/**
 * Uniform plasma is presentation chrome, not modeled exposure. It deliberately
 * fills the entire plot so unavailable time/price space is deep-colored rather
 * than confused with a valid zero-liquidity cell.
 */
export function bclifThermalBackdropStyle(name: LiquidationFieldPalette): BclifThermalBackdropStyle {
  if (name === "BLACK_TERMINAL_BLOOD" || name === "DIRECTIONAL_SPLIT") return {
    top: 0x210007, middle: 0x080205, bottom: 0x260008, invalid: 0x120207
  };
  if (name === "INSTITUTIONAL_MONOCHROME" || name === "CONFIDENCE") return {
    top: 0x12151a, middle: 0x05070a, bottom: 0x171a1f, invalid: 0x0c0f13
  };
  return { top: 0x28003f, middle: 0x071435, bottom: 0x31003d, invalid: 0x23003c };
}

export function interpolateBclifThermalColor(left: number, right: number, amount: number) {
  const t = Math.max(0, Math.min(1, amount));
  const channel = (shift: number) => Math.round(
    ((left >> shift) & 0xff) + (((right >> shift) & 0xff) - ((left >> shift) & 0xff)) * t
  );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function createThermalPalette(name: LiquidationFieldPalette, entries = 256) {
  if (name === "REFERENCE_THERMAL") return createReferenceThermalPalette(entries);
  const stops = PALETTES[name] ?? REFERENCE_STOPS;
  const lut = new Uint8Array(entries * 4);
  for (let index = 0; index < entries; index++) {
    const position = index / Math.max(1, entries - 1);
    let rightIndex = stops.findIndex(([stop]) => stop >= position);
    if (rightIndex < 0) rightIndex = stops.length - 1;
    const leftIndex = Math.max(0, rightIndex - 1);
    const [leftStop, leftHex] = stops[leftIndex]!;
    const [rightStop, rightHex] = stops[rightIndex]!;
    const span = Math.max(1e-9, rightStop - leftStop);
    const t = Math.max(0, Math.min(1, (position - leftStop) / span));
    const left = parseHex(leftHex).map(srgbToLinear);
    const right = parseHex(rightHex).map(srgbToLinear);
    lut[index * 4] = linearToSrgb(left[0]! + (right[0]! - left[0]!) * t);
    lut[index * 4 + 1] = linearToSrgb(left[1]! + (right[1]! - left[1]!) * t);
    lut[index * 4 + 2] = linearToSrgb(left[2]! + (right[2]! - left[2]!) * t);
    lut[index * 4 + 3] = 255;
  }
  return lut;
}

function createReferenceThermalPalette(entries: number) {
  const lut = new Uint8Array(entries * 4);
  const sourceEntries = BCLIF_REFERENCE_LUT_RGB.length / 3;
  for (let index = 0; index < entries; index += 1) {
    const position = index / Math.max(1, entries - 1) * (sourceEntries - 1);
    const lower = Math.floor(position);
    const upper = Math.min(sourceEntries - 1, lower + 1);
    const fraction = position - lower;
    for (let channel = 0; channel < 3; channel += 1) {
      const left = BCLIF_REFERENCE_LUT_RGB[lower * 3 + channel]!;
      const right = BCLIF_REFERENCE_LUT_RGB[upper * 3 + channel]!;
      lut[index * 4 + channel] = Math.round(left + (right - left) * fraction);
    }
    lut[index * 4 + 3] = 255;
  }
  return lut;
}

/**
 * Render-only transfer function for the thermal field. It preserves the
 * immutable model matrix while compressing the broad low-energy population
 * into the dark-purple range and reserving teal/green/yellow for progressively
 * rarer shelves and cores. Increasing sharpness raises both the black floor
 * and the contrast exponent; gamma remains an independent display control.
 */
export function shapeThermalIntensity(value: number, sharpness: number, gamma = 1) {
  const unit = Math.max(0, Math.min(1, value / 255));
  if (unit <= 0) return 0;
  const adjusted = Math.pow(unit, Math.max(0.2, Math.min(2.5, gamma)));
  const strength = Math.max(0, Math.min(1, sharpness / 100));
  const floor = 0.91 + strength * 0.035;
  const lifted = Math.max(0, Math.min(1, (adjusted - floor) / Math.max(1e-9, 1 - floor)));
  const exponent = 1.15 + strength * 0.85;
  return Math.max(0, Math.min(255, Math.round(255 * Math.pow(lifted, exponent))));
}

/**
 * Resolves a renderer sample entirely from immutable, causally normalized
 * snapshot channels. Directional views must never divide historical cells by
 * a later atlas-wide maximum because that would repaint an old replay prefix.
 */
export function resolveLiquidationFieldRenderIntensity(
  snapshot: LiquidationFieldSnapshot,
  settings: LiquidationFieldSettings,
  sourceIndex: number
) {
  let intensity = snapshot.normalizedIntensity[sourceIndex] ?? 0;
  let palette: LiquidationFieldPalette = settings.palette;
  if (settings.viewMode === "LONG_EXPOSURE") {
    intensity = snapshot.longNormalizedIntensity[sourceIndex] ?? 0;
    palette = "BLACK_TERMINAL_BLOOD";
  } else if (settings.viewMode === "SHORT_EXPOSURE") {
    intensity = snapshot.shortNormalizedIntensity[sourceIndex] ?? 0;
    palette = "INSTITUTIONAL_MONOCHROME";
  } else if (settings.viewMode === "CONFIDENCE_FIELD") {
    intensity = snapshot.confidence[sourceIndex] ?? 0;
  } else if (settings.viewMode === "CONFIRMED_LIQUIDATIONS") {
    intensity = snapshot.confirmedIntensity[sourceIndex] ?? 0;
  } else if (settings.viewMode === "DIRECTIONAL_SPLIT") {
    const long = snapshot.longExposure[sourceIndex] ?? 0;
    const short = snapshot.shortExposure[sourceIndex] ?? 0;
    intensity = Math.max(
      snapshot.longNormalizedIntensity[sourceIndex] ?? 0,
      snapshot.shortNormalizedIntensity[sourceIndex] ?? 0
    );
    palette = long >= short ? "BLACK_TERMINAL_BLOOD" : "INSTITUTIONAL_MONOCHROME";
  }
  if (settings.viewMode !== "CONFIRMED_LIQUIDATIONS") {
    const gamma = snapshot.authority === "PERSISTENT_NODE" ? settings.gamma : 1;
    intensity = shapeThermalIntensity(intensity, settings.sharpness, gamma);
  }
  return { intensity, palette };
}

export const REFERENCE_THERMAL_LUT = createThermalPalette("REFERENCE_THERMAL");
export const REFERENCE_THERMAL_CALIBRATION_SHA256 = BCLIF_REFERENCE_LUT_SOURCE_SHA256;

export function bclifThermalLutHash(name: LiquidationFieldPalette) {
  const bytes = createThermalPalette(name);
  let hash = 0x811c9dc5;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}
