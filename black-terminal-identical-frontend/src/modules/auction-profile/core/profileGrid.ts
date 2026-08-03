import type { Candle } from "../../../chart-engine/types.ts";
import type { SymbolMetadata } from "../../../market-data/types.ts";
import type { AuctionProfileGrid, AuctionProfileSettings } from "./types.ts";

function parseTickSize(metadata: SymbolMetadata | undefined, referencePrice: number) {
  const parsed = Number(metadata?.tickSize);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(referencePrice, Number.EPSILON)));
  return Math.max(Number.EPSILON, magnitude / 100_000);
}

function averageTrueRange(bars: readonly Candle[]) {
  if (!bars.length) return 0;
  let total = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const previous = bars[index - 1];
    total += Math.max(
      bar.high - bar.low,
      previous ? Math.abs(bar.high - previous.close) : 0,
      previous ? Math.abs(bar.low - previous.close) : 0
    );
  }
  return total / bars.length;
}

function roundToTick(value: number, tick: number) {
  return Math.max(tick, Math.round(value / tick) * tick);
}

export function createAuctionProfileGrid(
  bars: readonly Candle[],
  settings: AuctionProfileSettings,
  metadata?: SymbolMetadata
): AuctionProfileGrid {
  const priceLow = Math.min(...bars.map(bar => bar.low));
  const priceHigh = Math.max(...bars.map(bar => bar.high));
  const firstPrice = bars[0]?.open ?? 1;
  const tickSize = parseTickSize(metadata, firstPrice);
  const range = Math.max(tickSize, priceHigh - priceLow);
  let rowSize: number;
  switch (settings.rowSizingMode) {
    case "TICKS": rowSize = tickSize * settings.ticksPerRow; break;
    case "PRICE": rowSize = settings.rowSizePrice; break;
    case "BASIS_POINTS": rowSize = firstPrice * settings.basisPointsPerRow / 10_000; break;
    case "ATR_FRACTION": rowSize = averageTrueRange(bars) * settings.atrFraction; break;
    case "FIXED_ROW_COUNT":
    case "VISIBLE_PIXEL_ADAPTIVE":
    case "AUTO":
    default: rowSize = range / Math.max(1, settings.targetRows); break;
  }
  rowSize = roundToTick(Math.max(tickSize, rowSize), tickSize);
  let rowCount = Math.max(1, Math.ceil(range / rowSize) + 1);
  if (rowCount > settings.maximumRows) {
    rowSize = roundToTick(range / settings.maximumRows, tickSize);
    rowCount = Math.max(1, Math.ceil(range / rowSize) + 1);
  }
  let anchor = 0;
  if (settings.gridAnchor === "PROFILE_OPEN") anchor = Math.floor(firstPrice / rowSize) * rowSize;
  if (settings.gridAnchor === "ROUND_NUMBER") anchor = Math.floor(priceLow / (rowSize * 10)) * rowSize * 10;
  if (settings.gridAnchor === "FIXED_ORIGIN") anchor = 0;
  if (settings.gridAnchor === "INSTRUMENT_TICK_ORIGIN") anchor = Math.floor(priceLow / tickSize) * tickSize;
  if (settings.gridAnchor === "MANUAL_ORIGIN") anchor = settings.manualGridOrigin ?? 0;
  const origin = anchor + Math.floor((priceLow - anchor) / rowSize) * rowSize;
  rowCount = Math.min(settings.maximumRows, Math.max(1, Math.ceil((priceHigh - origin) / rowSize) + 1));
  return {
    origin,
    rowSize,
    rowCount,
    priceLow: origin,
    priceHigh: origin + rowCount * rowSize,
    tickSize,
    anchor: settings.gridAnchor,
    stable: settings.rowSizingMode !== "VISIBLE_PIXEL_ADAPTIVE"
  };
}

export function auctionRowIndex(grid: AuctionProfileGrid, price: number) {
  return Math.min(grid.rowCount - 1, Math.max(0, Math.floor((price - grid.origin) / grid.rowSize)));
}
