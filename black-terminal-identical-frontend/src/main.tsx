import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerBlackCoreServices } from "./core/registerBlackCore";
import { blackCorePerformanceMonitor } from "./performance/performanceMonitor";
import { blackCoreMarketDataEngine } from "./market-data/engine/marketDataEngine";
import type { MarketSymbol } from "./market-data/types";
import "./styles/theme.css";

registerBlackCoreServices();

if (window.location.hostname === "127.0.0.1" && new URLSearchParams(window.location.search).get("perfHarness") === "1") {
  (window as Window & { __BLACK_TERMINAL_PERFORMANCE__?: typeof blackCorePerformanceMonitor }).__BLACK_TERMINAL_PERFORMANCE__ = blackCorePerformanceMonitor;
  installDomProVisualFixture();
}

function installDomProVisualFixture() {
  const symbol: MarketSymbol = { exchange: "binance", rawSymbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", marketKind: "perpetual", pricePrecision: 1 };
  const now = Math.floor(Date.now() / 1000);
  const midpoint = 64_000.25;
  blackCoreMarketDataEngine.cache.setOrderBook({
    exchange: "binance",
    symbol: symbol.rawSymbol,
    // Keep the deterministic browser fixture fresh for the full visual suite.
    time: now + 3_600,
    subscribedDepth: 200,
    sequence: 10_001,
    bids: Array.from({ length: 200 }, (_, index) => ({ price: 64_000 - index * 0.5, quantity: 1 + index / 18 + (index % 19 === 0 ? 18 : 0) })),
    asks: Array.from({ length: 200 }, (_, index) => ({ price: 64_000.5 + index * 0.5, quantity: 1.2 + index / 21 + (index % 23 === 0 ? 22 : 0) }))
  });
  blackCoreMarketDataEngine.cache.setTicker({
    exchange: "binance",
    symbol: symbol.rawSymbol,
    time: now,
    lastPrice: midpoint,
    bidPrice: 64_000,
    askPrice: 64_000.5,
    highPrice: 65_320,
    lowPrice: 62_840,
    priceChangePercent: 1.12,
    quoteVolume: 9_450_000_000
  });
  blackCoreMarketDataEngine.cache.setCandles(symbol, "1d", Array.from({ length: 365 }, (_, index) => {
    const center = 61_000 + Math.sin(index / 17) * 7_000 + index * 10;
    return { time: now - (364 - index) * 86_400, open: center - 300, high: center + 1_100, low: center - 1_250, close: center + 220, volume: 25_000 + index * 80 };
  }));
  for (let index = 0; index < 180; index += 1) {
    blackCoreMarketDataEngine.cache.appendTrade({
      exchange: "binance",
      symbol: symbol.rawSymbol,
      tradeId: `dom-visual-${index}`,
      time: now - (180 - index),
      price: midpoint + Math.sin(index / 8) * 22,
      quantity: 0.02 + index % 11 * 0.003,
      side: index % 3 === 0 ? "sell" : "buy"
    });
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <React.Profiler id="BlackTerminal" onRender={(_id, phase, actualDuration, baseDuration) => {
      blackCorePerformanceMonitor.recordMetric("react.commit_ms", actualDuration, "ms", { phase });
      blackCorePerformanceMonitor.recordMetric("react.base_duration_ms", baseDuration, "ms", { phase });
    }}>
      <App />
    </React.Profiler>
  </React.StrictMode>
);
