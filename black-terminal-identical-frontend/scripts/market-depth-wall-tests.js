import assert from "node:assert/strict";
import { detectWallLifecycle } from "../server/market-depth/wall-lifecycle-engine.js";

const sample = {
  venue: "hyperliquid",
  marketKind: "perpetual",
  symbol: "BTCUSDT",
  capturedAt: Date.now(),
  midPrice: 105,
  bids: [
    { price: 100, quantity: 100, side: "bid" },
    { price: 101, quantity: 90, side: "bid" },
    { price: 90, quantity: 1, side: "bid" }
  ],
  asks: [
    { price: 110, quantity: 80, side: "ask" },
    { price: 111, quantity: 70, side: "ask" },
    { price: 120, quantity: 1, side: "ask" }
  ]
};

const result = detectWallLifecycle(sample, { bucketSize: 10 }, new Map());
assert.equal(result.walls.length, 2, "same-side depth levels in one price bucket must become one wall");
assert.equal(new Set(result.walls.map((wall) => wall.wallKey)).size, result.walls.length, "wall upsert keys must be unique per batch");
assert.equal(result.walls.find((wall) => wall.side === "buy")?.currentSize, 190, "buy wall size aggregates its price bucket");
assert.equal(result.walls.find((wall) => wall.side === "sell")?.currentSize, 150, "sell wall size aggregates its price bucket");

console.log("Market-depth wall aggregation regression passed: duplicate upsert keys are eliminated without dropping liquidity.");
