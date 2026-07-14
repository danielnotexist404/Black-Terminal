import { performance } from "node:perf_hooks";
import type { Candle } from "../src/chart-engine/types.ts";
import { calculateAif } from "../src/modules/aif/core/aifEngine.ts";
import { defaultAifSettings } from "../src/modules/aif/state/aifStore.ts";
import type { AifImplementedProfileType } from "../src/modules/aif/core/aifTypes.ts";

const sizes = [5000, 20000, 50000, 100000];
const rows = [100, 300, 500, 1000];
const profiles: AifImplementedProfileType[] = ["volume", "delta", "tpo", "volatility", "pressure"];
const all = syntheticCandles(100000);
const results: Array<{ bars: number; rows: number; profile: string; pair: string; ms: number; normalizeMs: number; profileMs: number; nodesMs: number; eventsMs: number; renderMs: number; nodes: number; memoryMb: number }> = [];
for (const bars of sizes) for (const rowCount of rows) for (const profile of profiles) {
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const model = calculateAif({ id: 1, generation: 1, marketSymbol: { exchange: "bybit", rawSymbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", marketKind: "perpetual" }, timeframe: "1m", candles: all.slice(-bars), currentPrice: all.at(-1)!.close, settings: { ...defaultAifSettings(), primaryProfile: profile, lookbackBars: bars, rowCount }, sourceVersion: "benchmark" });
  results.push(record(bars, rowCount, profile, "off", started, before, model));
}
for (const bars of sizes) for (const secondaryProfile of ["delta", "tpo", "volatility"] as const) {
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const model = calculateAif({ id: 1, generation: 1, marketSymbol: { exchange: "bybit", rawSymbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", marketKind: "perpetual" }, timeframe: "1m", candles: all.slice(-bars), currentPrice: all.at(-1)!.close, settings: { ...defaultAifSettings(), primaryProfile: "volume", secondaryProfile, lookbackBars: bars, rowCount: 300 }, sourceVersion: "benchmark-pair" });
  results.push(record(bars, 300, "volume", secondaryProfile, started, before, model));
}
console.table(results);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), engine: "aif-engine/1.1.0", results }));

function record(bars: number, rowCount: number, profile: string, pair: string, started: number, before: number, model: ReturnType<typeof calculateAif>) {
  return { bars, rows: rowCount, profile, pair, ms: Number((performance.now() - started).toFixed(2)), normalizeMs: Number(model.timings.normalizationMs.toFixed(2)), profileMs: Number(model.timings.profileMs.toFixed(2)), nodesMs: Number(model.timings.nodeAndStabilityMs.toFixed(2)), eventsMs: Number(model.timings.eventMs.toFixed(2)), renderMs: Number(model.timings.renderModelMs.toFixed(2)), nodes: model.primaryNodes.length, memoryMb: Number(((process.memoryUsage().heapUsed - before) / 1048576).toFixed(2)) };
}

function syntheticCandles(count: number): Candle[] {
  const output: Candle[] = [];
  let close = 12000;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = Math.max(100, open + Math.sin(index / 41) * 8 + 0.18);
    output.push({ time: 1_600_000_000 + index * 60, open, high: Math.max(open, close) + 14 + index % 9, low: Math.min(open, close) - 12 - index % 7, close, volume: 20 + index % 400 });
  }
  return output;
}
