import type { AuctionProfileKeyLevels, AuctionProfileRow, AuctionProfileSettings } from "./types.ts";

function basis(row: AuctionProfileRow, settings: AuctionProfileSettings) {
  switch (settings.valueAreaBasis) {
    case "TOTAL_VOLUME": return row.totalQuantity;
    case "BUY_VOLUME": return row.buyQuantity;
    case "SELL_VOLUME": return row.sellQuantity;
    case "POSITIVE_SIDE": return Math.max(0, row.value);
    case "NEGATIVE_SIDE": return Math.abs(Math.min(0, row.value));
    case "TPO": return row.tpoCount;
    case "HYBRID": return Math.abs(row.hybridScore);
    case "ABSOLUTE_VALUE": return Math.abs(row.value);
    case "SELECTED_ENGINE":
    default: return Math.max(0, row.value);
  }
}

function pocBasis(row: AuctionProfileRow, settings: AuctionProfileSettings) {
  switch (settings.pocBasis) {
    case "MAXIMUM_ABSOLUTE_METRIC": return Math.abs(row.value);
    case "MAXIMUM_POSITIVE_METRIC": return Math.max(0, row.value);
    case "MINIMUM_NEGATIVE_METRIC": return Math.abs(Math.min(0, row.value));
    case "MAXIMUM_TOTAL_VOLUME": return row.totalQuantity;
    case "MAXIMUM_TPO": return row.tpoCount;
    case "HYBRID": return Math.abs(row.hybridScore);
    case "MAXIMUM_SELECTED_METRIC":
    default: return row.value;
  }
}

function maximumIndex(rows: readonly AuctionProfileRow[], selector: (row: AuctionProfileRow) => number) {
  let winner = -1;
  let maximum = -Infinity;
  rows.forEach((row, index) => {
    const value = selector(row);
    if (value > maximum) {
      maximum = value;
      winner = index;
    }
  });
  return winner;
}

export function calculateAuctionKeyLevels(
  rows: AuctionProfileRow[],
  settings: AuctionProfileSettings,
  initialBalance?: { high: number; low: number }
): AuctionProfileKeyLevels {
  if (!rows.length) return { poc: null, vah: null, val: null, midpoint: null, ibHigh: null, ibLow: null, cvdPoc: null, buyPoc: null, sellPoc: null, tpoPoc: null, volatilityPoc: null, dominantLvn: null, dominantHvn: null };
  const pocIndex = Math.max(0, maximumIndex(rows, row => pocBasis(row, settings)));
  const weights = rows.map(row => Math.max(0, basis(row, settings)));
  const target = weights.reduce((sum, value) => sum + value, 0) * settings.valueAreaFraction;
  let low = pocIndex;
  let high = pocIndex;
  let accumulated = weights[pocIndex] ?? 0;
  while (accumulated < target && (low > 0 || high < rows.length - 1)) {
    const below = low > 0 ? weights[low - 1]! : -1;
    const above = high < rows.length - 1 ? weights[high + 1]! : -1;
    if (above > below) {
      high += 1;
      accumulated += Math.max(0, above);
    } else {
      low -= 1;
      accumulated += Math.max(0, below);
    }
  }
  rows.forEach((row, index) => { row.inValueArea = index >= low && index <= high; });
  const center = (index: number) => rows[Math.max(0, index)]?.center ?? null;
  return {
    poc: center(pocIndex),
    vah: rows[high]?.high ?? null,
    val: rows[low]?.low ?? null,
    midpoint: (rows[0]!.low + rows[rows.length - 1]!.high) / 2,
    ibHigh: initialBalance?.high ?? null,
    ibLow: initialBalance?.low ?? null,
    cvdPoc: center(maximumIndex(rows, row => Math.abs(row.buyQuantity - row.sellQuantity))),
    buyPoc: center(maximumIndex(rows, row => row.buyQuantity)),
    sellPoc: center(maximumIndex(rows, row => row.sellQuantity)),
    tpoPoc: center(maximumIndex(rows, row => row.tpoCount)),
    volatilityPoc: center(maximumIndex(rows, row => row.realizedVariance)),
    dominantLvn: null,
    dominantHvn: null
  };
}
