import type { AuctionCalculationEngine, AuctionProfileRow } from "../core/types.ts";

export function volumeMetricValue(row: AuctionProfileRow, engine: AuctionCalculationEngine) {
  if (engine === "BUY_VOLUME") return row.buyQuantity;
  if (engine === "SELL_VOLUME") return row.sellQuantity;
  if (engine === "DELTA_VOLUME") return row.buyQuantity - row.sellQuantity;
  if (engine === "IMBALANCE_RATIO") return (row.buyQuantity - row.sellQuantity) / Math.max(row.buyQuantity + row.sellQuantity, Number.EPSILON);
  if (engine === "TRADE_COUNT") return row.tradeCount;
  if (engine === "AVERAGE_TRADE_SIZE") return row.averageTradeSize;
  return row.totalQuantity;
}
