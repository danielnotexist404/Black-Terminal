import type { BclifEvidenceClass } from "../core/types.ts";
import type { BclifDisplayProjection } from "../rendering/displayProjection.ts";

const EMPTY_EVIDENCE = (): Record<BclifEvidenceClass, number> => ({
  OI_ONLY: 0,
  OI_PLUS_PRICE: 0,
  OI_PLUS_TRADES: 0,
  OI_PLUS_TRADES_PLUS_LIQUIDATIONS: 0,
  OI_PLUS_TRADES_PLUS_BOOK: 0,
  FULL_CONTEXT: 0
});

/**
 * Renderer-only style fixture. It never enters the BCLIF model and therefore
 * cannot be mistaken for market evidence. Scores create horizontal shelves;
 * rank assignment gives the formal C6 family occupancy distribution exactly.
 */
export function createBclifReferenceThermalStyleFixture(columns = 320, rows = 180): BclifDisplayProjection {
  const cells = columns * rows;
  const intensity = new Uint8Array(cells);
  const confidence = new Uint8Array(cells);
  const alpha = new Uint8Array(cells).fill(255);
  const validity = new Uint8Array(cells).fill(255);
  const yellowEligible = new Uint8Array(cells);
  const shelves = [
    { y: 26 / 180, start: 0.04, end: 0.98, width: 2.2 / 180, strength: 2.15 },
    { y: 47 / 180, start: 0.00, end: 0.72, width: 3.8 / 180, strength: 1.05 },
    { y: 64 / 180, start: 0.18, end: 1.00, width: 2.8 / 180, strength: 1.42 },
    { y: 83 / 180, start: 0.00, end: 0.44, width: 2.0 / 180, strength: 1.22 },
    { y: 102 / 180, start: 0.31, end: 0.89, width: 3.4 / 180, strength: 1.18 },
    { y: 121 / 180, start: 0.08, end: 1.00, width: 2.6 / 180, strength: 1.62 },
    { y: 145 / 180, start: 0.46, end: 1.00, width: 1.2 / 180, strength: 2.85 },
    { y: 163 / 180, start: 0.62, end: 0.94, width: 3.6 / 180, strength: 1.34 }
  ] as const;

  const scoreAt = (time: number, price: number) => {
    let score = 0.09 * Math.sin(price * 180 * 0.113 + time * 320 * 0.017)
      + 0.06 * Math.cos(price * 180 * 0.071 - time * 320 * 0.029);
    for (const shelf of shelves) {
      if (time < shelf.start || time > shelf.end) continue;
      const life = (time - shelf.start) / Math.max(1e-6, shelf.end - shelf.start);
      const persistence = Math.min(1, life * 7) * Math.min(1, (1 - life) * 12 + 0.28);
      const distance = (price - shelf.y) / shelf.width;
      score += shelf.strength * persistence * Math.exp(-0.5 * distance * distance);
    }
    return score;
  };
  const referenceScores: number[] = [];
  for (let column = 0; column < 320; column += 1) {
    const time = column / 319;
    if (time >= 0.385 && time < 0.395) continue;
    for (let row = 0; row < 180; row += 1) referenceScores.push(scoreAt(time, row / 179));
  }
  referenceScores.sort((left, right) => left - right);
  const upperBound = (value: number) => {
    let low = 0;
    let high = referenceScores.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (referenceScores[middle]! <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  let validCells = 0;
  for (let column = 0; column < columns; column += 1) {
    const time = column / Math.max(1, columns - 1);
    const missing = time >= 0.385 && time < 0.395;
    for (let row = 0; row < rows; row += 1) {
      const index = column * rows + row;
      if (missing) {
        validity[index] = 0;
        alpha[index] = 0;
        continue;
      }
      const price = row / Math.max(1, rows - 1);
      const quantile = Math.max(0, Math.min(1, (upperBound(scoreAt(time, price)) - 0.5) / referenceScores.length));
      const value = quantile < 0.62 ? 15 + Math.floor(120 * quantile / 0.62)
        : quantile < 0.91 ? 140 + Math.floor(75 * (quantile - 0.62) / 0.29)
          : quantile < 0.997 ? 221 + Math.floor(31 * (quantile - 0.91) / 0.087)
            : 255;
      intensity[index] = value;
      confidence[index] = Math.round(104 + 130 * (0.5 + 0.5 * Math.sin((time * 320 * 180 + price * 180) * 0.017)));
      if (value === 255) yellowEligible[index] = 255;
      validCells += 1;
    }
  }

  const missingCells = cells - validCells;
  const minPrice = 50_000;
  const maxPrice = 80_000;
  return {
    columns,
    rows,
    minPrice,
    maxPrice,
    priceStep: (maxPrice - minPrice) / Math.max(1, rows - 1),
    timeStepMs: 60_000,
    intensity,
    confidence,
    alpha,
    validity,
    yellowEligible,
    yellowEligibleCells: yellowEligible.filter(Boolean).length,
    historicalCells: validCells,
    liveCalibratedCells: 0,
    missingCells,
    validCells,
    rawNonZeroCells: validCells,
    visibleCells: validCells,
    filteredCells: 0,
    minimumVisibleAlpha: 255,
    maximumAlpha: 255,
    validModelRowsInDisplay: rows,
    rowsClippedBelow: 0,
    rowsClippedAbove: 0,
    evidenceCounts: EMPTY_EVIDENCE(),
    liveCalibrationStartTime: null,
    modelHash: "SYNTHETIC_TEST",
    exposureHash: "SYNTHETIC_TEST",
    renderSettingsHash: "SYNTHETIC_TEST",
    displayRasterHash: "SYNTHETIC_TEST_REFERENCE_THERMAL_V3"
  };
}
