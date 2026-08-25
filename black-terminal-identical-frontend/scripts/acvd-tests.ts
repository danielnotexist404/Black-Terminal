import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateAcvd } from "../src/modules/acvd/core/engine.ts";
import { DEFAULT_ACVD_SETTINGS, migrateAcvdSettings } from "../src/modules/acvd/core/settings.ts";
import type { AuthenticFlowBarInput } from "../src/modules/acvd/core/types.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import { AcvdWorkerClient } from "../src/modules/acvd/workers/AcvdWorkerClient.ts";

const seconds = 14_400;

function fixture(length = 220) {
  const candles: Candle[] = [];
  const flowBars: AuthenticFlowBarInput[] = [];
  let close = 100;
  for (let index = 0; index < length; index++) {
    const wave = Math.sin(index / 12) * 0.18;
    const next = close + wave;
    candles.push({ time: 1_700_000_000 + index * seconds, open: close, high: Math.max(close, next) + 0.25, low: Math.min(close, next) - 0.25, close: next, volume: 100 });
    flowBars.push({ time: candles[index]!.time, buyVolume: 50, sellVolume: 50, unknownVolume: 0, buyNotional: 5000, sellNotional: 5000, unknownNotional: 0, exactTradeCount: 20, totalTradeCount: 20, deliveryComplete: true });
    close = next;
  }

  // A causal lower-structure sweep, authentic selling exhaustion, delta turn,
  // then a later closed-bar displacement confirmation.
  const priorLow = Math.min(...candles.slice(82, 122).map((bar) => bar.low));
  for (let index = 116; index <= 121; index++) {
    flowBars[index] = { ...flowBars[index]!, buyNotional: 300, sellNotional: 9700, buyVolume: 3, sellVolume: 97 };
  }
  candles[122] = { ...candles[122]!, open: priorLow + 0.32, high: priorLow + 0.46, low: priorLow - 0.75, close: priorLow + 0.22 };
  flowBars[122] = { ...flowBars[122]!, buyNotional: 8700, sellNotional: 1300, buyVolume: 87, sellVolume: 13 };
  candles[123] = { ...candles[123]!, open: priorLow + 0.22, high: priorLow + 1.15, low: priorLow + 0.12, close: priorLow + 1.02 };
  flowBars[123] = { ...flowBars[123]!, buyNotional: 9300, sellNotional: 700, buyVolume: 93, sellVolume: 7 };
  for (let index = 124; index < length; index++) {
    const previous = candles[index - 1]!.close;
    candles[index] = { ...candles[index]!, open: previous, high: previous + 0.65, low: previous - 0.12, close: previous + 0.45 };
    flowBars[index] = { ...flowBars[index]!, buyNotional: 7200, sellNotional: 2800, buyVolume: 72, sellVolume: 28 };
  }
  return { candles, flowBars };
}

const selective = migrateAcvdSettings({
  ...DEFAULT_ACVD_SETTINGS,
  lookback: 1000,
  smoothingMode: "EMA",
  smoothingLength: 2,
  normalizationLookback: 40,
  envelopeLookback: 40,
  envelopeDeviation: 1,
  minimumEnvelopeWidth: 2,
  structureLookback: 40,
  structureToleranceAtr: 0.9,
  minimumRejectionWickRatio: 0.05,
  confirmationBars: 3,
  trendProtection: false,
  minimumDivergenceScore: 0,
  minimumExtremeScore: 20,
  minimumReversalImpulse: 1,
  minimumSignalConfidence: 40,
  maximumChopProbability: 100,
  cooldownBars: 8
});

const { candles, flowBars } = fixture();
const input = { candles, flowBars, flowAuthority: "EXACT_AGGRESSOR_TRADES" as const, settings: selective, timeframeSeconds: seconds, lastBarConfirmed: true, marketIdentity: "bybit:BTCUSDT:4h" };
const snapshot = calculateAcvd(input);
assert.equal(snapshot.authority, "EXACT_AGGRESSOR_TRADES");
assert.equal(snapshot.integrity.causal, true);
assert.equal(snapshot.integrity.futureBarsConsumed, 0);
assert.equal(snapshot.integrity.closedBarSignalsOnly, true);
assert.ok(snapshot.series.cumulativeDelta.some(Number.isFinite), "authentic aggressor flow produces real CVD");
assert.ok(snapshot.signals.some((signal) => signal.direction === "long"), "confirmed selling exhaustion produces a selective long signal");
assert.ok(snapshot.signals.every((signal) => signal.executionEligibleTimestamp === signal.time + seconds), "signals become executable no earlier than the next bar");

const unavailable = calculateAcvd({ candles, settings: selective, flowAuthority: "UNAVAILABLE", timeframeSeconds: seconds, marketIdentity: "bybit:BTCUSDT:4h" });
assert.equal(unavailable.authority, "UNAVAILABLE");
assert.equal(unavailable.signals.length, 0, "missing authentic flow never falls back to synthetic candle delta");

for (const prefixLength of [126, 160, 200]) {
  const prefix = calculateAcvd({ ...input, candles: candles.slice(0, prefixLength), flowBars: flowBars.slice(0, prefixLength) });
  const fullSignalsAtPrefix = snapshot.signals.filter((signal) => signal.index < prefixLength);
  assert.deepEqual(prefix.signals, fullSignalsAtPrefix, `finalized signals remain prefix-stable at ${prefixLength} bars`);
  for (let index = 0; index < prefixLength; index++) {
    const left = prefix.series.adaptivePressure[index];
    const right = snapshot.series.adaptivePressure[index];
    if (Number.isNaN(left) && Number.isNaN(right)) continue;
    assert.equal(left, right, `pressure is prefix-stable at index ${index}`);
  }
}

const developing = calculateAcvd({ ...input, lastBarConfirmed: false });
assert.ok(developing.signals.every((signal) => signal.index < candles.length - 1), "developing candle cannot finalize a signal");

const incompleteFlow = flowBars.map((bar, index) => index === 122 ? { ...bar, deliveryComplete: false } : bar);
const incomplete = calculateAcvd({ ...input, flowBars: incompleteFlow });
assert.ok(!Number.isFinite(incomplete.series.adaptivePressure[122]), "an incomplete delivery interval creates a visible causal gap");

const client = new AcvdWorkerClient(() => { throw new Error("force inline"); });
const workerSnapshot = await client.calculate(input);
assert.equal(workerSnapshot.dataHash, snapshot.dataHash, "worker and direct engine remain deterministic");
client.dispose();

const large = fixture(20_000);
const benchmarkStarted = performance.now();
const largeSnapshot = calculateAcvd({ ...input, candles: large.candles, flowBars: large.flowBars, settings: migrateAcvdSettings({ ...selective, lookback: 20_000 }) });
const benchmarkMs = performance.now() - benchmarkStarted;
assert.equal(largeSnapshot.inputSize, 20_000);
assert.ok(benchmarkMs < 3_000, `20K-bar causal calculation exceeded the 3s regression ceiling (${benchmarkMs.toFixed(1)}ms)`);

const source = readFileSync(new URL("../src/modules/acvd/core/engine.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /candle\.(close|open)\s*[><=]+\s*candle\.(open|close).*delta/i, "engine does not infer CVD from candle direction");
const library = readFileSync(new URL("../src/components/IndicatorLibrary.tsx", import.meta.url), "utf8");
assert.match(library, /BC-ACVD — Adaptive Causal Volume Delta/);
const chart = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
assert.match(chart, /CAUSAL · CLOSED-BAR SIGNALS · NO SYNTHETIC CVD/);
assert.match(chart, /black-terminal:acvd-signal/);

console.log(`BC-ACVD tests passed (${snapshot.inputSize} bars, ${snapshot.signals.length} finalized signals, exact flow only, prefix-stable; 20K in ${benchmarkMs.toFixed(1)}ms).`);
