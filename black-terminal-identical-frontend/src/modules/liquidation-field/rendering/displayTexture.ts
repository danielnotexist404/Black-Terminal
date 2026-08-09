import type { LiquidationFieldSettings } from "../core/types.ts";
import type { BclifDisplayProjection } from "./displayProjection.ts";
import { bclifThermalBackdropStyle, createThermalPalette } from "./thermalPalette.ts";

/** Build the upload-ready, row-flipped RGBA texture. In normal browsers this
 * runs in the projection worker, keeping million-cell palette work off the
 * chart/render thread. */
export function buildBclifDisplayTexture(
  projection: BclifDisplayProjection,
  settings: LiquidationFieldSettings,
  reuse?: Uint8Array | null
) {
  const { columns, rows } = projection;
  const required = columns * rows * 4;
  const rgba = reuse?.length === required ? reuse : new Uint8Array(required);
  const lut = createThermalPalette(settings.palette);
  const longLut = createThermalPalette("BLACK_TERMINAL_BLOOD");
  const shortLut = createThermalPalette("INSTITUTIONAL_MONOCHROME");
  const invalid = bclifThermalBackdropStyle(settings.palette).invalid;
  const selectedLut = settings.viewMode === "LONG_EXPOSURE" ? longLut
    : settings.viewMode === "SHORT_EXPOSURE" ? shortLut : lut;

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
      const lutIndex = projection.intensity[sourceIndex]! * 4;
      rgba[targetIndex] = selectedLut[lutIndex]!;
      rgba[targetIndex + 1] = selectedLut[lutIndex + 1]!;
      rgba[targetIndex + 2] = selectedLut[lutIndex + 2]!;
      rgba[targetIndex + 3] = projection.alpha[sourceIndex]!;
    }
  }
  return rgba;
}
