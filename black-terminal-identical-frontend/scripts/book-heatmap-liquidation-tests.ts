import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfirmedLiquidationModel } from "../src/chart-engine/heatmap/ConfirmedLiquidationModel.ts";
import { parseBinanceLiquidationMessage, parseBybitLiquidationMessage } from "../src/chart-engine/heatmap/confirmedLiquidationFeed.ts";
import { LiquidationHeatmapModel } from "../src/chart-engine/heatmap/LiquidationHeatmapModel.ts";

const bybitRaw = readFileSync(new URL("../tests/fixtures/book-heatmap/bybit-confirmed-liquidation.json", import.meta.url), "utf8");
const binanceRaw = readFileSync(new URL("../tests/fixtures/book-heatmap/binance-confirmed-liquidation.json", import.meta.url), "utf8");
const bybit = parseBybitLiquidationMessage(bybitRaw);
const binance = parseBinanceLiquidationMessage(binanceRaw);
assert.equal(bybit.length, 1);
assert.equal(bybit[0].venue, "bybit");
assert.equal(bybit[0].liquidatedSide, "short");
assert.equal(binance.length, 1);
assert.equal(binance[0].venue, "binance");
assert.equal(binance[0].liquidatedSide, "short");
assert.equal(parseBybitLiquidationMessage('{"topic":"orderbook.200.BTCUSDT","data":[]}').length, 0);

const baseTime = 1_747_578_000;
const candles = Array.from({ length: 180 }, (_, index) => ({
  time: baseTime + index * 60,
  open: 100_000 + index * 4,
  high: 100_120 + index * 4,
  low: 99_880 + index * 4,
  close: 100_030 + index * 4,
  volume: 100 + (index % 17) * 20
}));
const confirmed = new ConfirmedLiquidationModel();
confirmed.setCandles(candles);
assert.equal(confirmed.ingest(bybit[0]), true);
assert.equal(confirmed.ingest(bybit[0]), false, "duplicate exchange event must be rejected");
assert.equal(confirmed.ingest(binance[0]), true);
const visible = confirmed.cells(0, candles.length - 1, 90_000, 110_000);
assert.equal(visible.length, 2);
assert.ok(visible.every((cell) => cell.classification === "CONFIRMED LIQUIDATION" && cell.confidence === 1));
assert.ok(visible.every((cell) => cell.notional === cell.price * cell.quantity));

for (let index = 0; index < 5_100; index += 1) {
  confirmed.ingest({
    id: `bounded:${index}`,
    venue: "bybit",
    symbol: "BTCUSDT",
    time: (baseTime + 120) * 1000 + index,
    price: 100_000 + index * 0.01,
    quantity: 0.1,
    liquidatedSide: index % 2 ? "long" : "short",
    priceKind: "bankruptcy"
  });
}
assert.equal(confirmed.diagnostics((baseTime + 121) * 1000).events, 5_000);

const estimated = new LiquidationHeatmapModel();
estimated.setSource(candles);
const estimatedCells = estimated.visibleCells(0, candles.length - 1, candles.length - 1, 80_000, 120_000);
assert.ok(estimatedCells.length > 0, "estimated price/volume/leverage model must produce bounded model-derived concentrations");
assert.ok(estimatedCells.every((cell) => cell.strength >= 0 && cell.strength <= 1));
assert.ok(estimatedCells.every((cell) => cell.classification === "ESTIMATED LIQUIDATION"));
assert.ok(estimatedCells.every((cell) => cell.confidence > 0 && cell.confidence < 1));
assert.ok(estimatedCells.every((cell) => cell.modelInputs.includes("LEVERAGE ASSUMPTIONS")));

console.log("Liquidation mode tests passed: recorded confirmed feeds, event dedup/bounds, provenance, and separate estimated model.");
