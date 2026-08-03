import type { Candle } from "../../../chart-engine/types.ts";
import type { CanonicalTrade } from "../core/types.ts";

export function auctionFixture(barCount = 100, start = 1_720_000_000) {
  const bars: Candle[] = Array.from({ length: barCount }, (_, index) => {
    const center = 60_000 + Math.sin(index / 17) * 900 + index * 0.4;
    return { time: start + index * 3600, open: center - 20, high: center + 90, low: center - 85, close: center + 15, volume: 100 + index % 31 };
  });
  const trades: CanonicalTrade[] = bars.flatMap((bar, index) => [
    { venue: "bybit", symbol: "BTCUSDT", timestamp: bar.time + 10, tradeId: "buy-" + index, price: bar.close + 5, quantity: 2 + index % 4, notional: (bar.close + 5) * (2 + index % 4), aggressorSide: "BUY", source: "EXCHANGE_AGGRESSOR_FLAG" },
    { venue: "bybit", symbol: "BTCUSDT", timestamp: bar.time + 20, tradeId: "sell-" + index, price: bar.close - 5, quantity: 1 + index % 3, notional: (bar.close - 5) * (1 + index % 3), aggressorSide: "SELL", source: "EXCHANGE_AGGRESSOR_FLAG" }
  ]);
  return { bars, trades };
}
