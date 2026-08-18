import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBybitTradingStopBody } from "../server/exchanges/bybit.js";
import { preserveFullPositionPair, reconcileProtectionReport } from "../server/routes/execution/protection.js";
import { resolveFixedLookbackWindow } from "../src/chart-engine/profile/VolumeProfileModel.ts";
import { deriveDDAProSignals } from "../src/modules/dda-pro/core/engineShared.ts";
import type { DDAProEvent } from "../src/modules/dda-pro/core/types.ts";

const stopOnly = buildBybitTradingStopBody({ category: "linear", symbol: "BTCUSDT", positionIdx: 2, tpslMode: "full", stopLoss: 61_000 });
assert.equal(stopOnly.stopLoss, "61000");
assert.equal(stopOnly.takeProfit, undefined, "omitted TP must never be serialized as cancellation");
assert.equal(stopOnly.positionIdx, 2, "hedge position identity must be preserved");
const explicitCancel = buildBybitTradingStopBody({ category: "linear", symbol: "BTCUSDT", positionIdx: 1, tpslMode: "full", takeProfit: 0 });
assert.equal(explicitCancel.takeProfit, "0", "only explicit zero cancellation becomes Bybit's cancel sentinel");
assert.throws(() => buildBybitTradingStopBody({ category: "linear", symbol: "BTCUSDT", stopLoss: 1 }), /explicit positionIdx/);
assert.throws(() => buildBybitTradingStopBody({ category: "linear", symbol: "BTCUSDT", positionIdx: 0, stopLoss: Number.NaN }), /finite non-negative/);

assert.deepEqual(preserveFullPositionPair(
  { category: "linear", symbol: "BTCUSDT", positionIdx: 2, tpslMode: "full", stopLoss: 61_000 },
  { takeProfit: 55_000, stopLoss: 66_000, trailingStop: null }
), { category: "linear", symbol: "BTCUSDT", positionIdx: 2, tpslMode: "full", stopLoss: 61_000, takeProfit: 55_000, trailingStop: undefined });
assert.equal(reconcileProtectionReport({
  accepted: { status: "accepted" },
  requestedPatch: { takeProfit: undefined, stopLoss: 61_000 },
  before: { takeProfit: 55_000, stopLoss: 66_000 },
  after: { takeProfit: 55_000, stopLoss: 61_000 }
}).status, "reconciled");
assert.throws(() => reconcileProtectionReport({
  accepted: { status: "accepted" }, requestedPatch: { stopLoss: 61_000 }, before: {}, after: { stopLoss: 60_000 }
}), /has not converged/);

assert.deepEqual(resolveFixedLookbackWindow(5_100, 5_000), { startIndex: 100, endIndex: 5_099 });
assert.deepEqual(resolveFixedLookbackWindow(5_101, 5_000), { startIndex: 101, endIndex: 5_100 }, "fixed look-back must roll on every appended candle");
assert.deepEqual(resolveFixedLookbackWindow(4_000, 5_000), { startIndex: 0, endIndex: 3_999 });

const event = (type: DDAProEvent["type"], index: number): DDAProEvent => ({
  id: `event-${index}`, type, index, time: 1_700_000_000 + index, state: "HIGH", value: 5
});
const signals = deriveDDAProSignals([event("DDA_DRAWDOWN_STARTED", 0), event("DDA_DRAWDOWN_DEEPENED", 1), event("DDA_DRAWDOWN_RECOVERED", 2)]);
assert.deepEqual(signals.map(({ direction, markerTone }) => ({ direction, markerTone })), [
  { direction: "short", markerTone: "blood-red" },
  { direction: "long", markerTone: "silver-white" }
]);
assert.equal(new Set(signals.map((signal) => signal.id)).size, signals.length);

const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/modules/portfolio-manager/components/PortfolioManagerPage.tsx", import.meta.url), "utf8");
const reconciliationSource = readFileSync(new URL("../server/exchanges/bybit-reconciliation.js", import.meta.url), "utf8");
assert.doesNotMatch(engineSource, /latestChartIndex[\s\S]{0,300}g\.circle/, "BC-RDA must not draw an unconditional latest-tip dot");
assert.match(engineSource, /snapshot\.signals/);
assert.match(engineSource, /volumeProfileRightGutter/);
assert.match(chartSource, /Fixed Look-back/);
assert.doesNotMatch(chartSource, /Lock Latest/);
assert.match(chartSource, /BC_RDA_ANY_SIGNAL/);
assert.match(chartSource, /supportZone/);
assert.doesNotMatch(panelSource, /TP\/SL ORDERS SUBMITTED/);
assert.match(panelSource, /updateBybitPositionProtectionViaApi/);
assert.match(reconciliationSource, /getBybitInstrumentMetadata[\s\S]*?\.catch\(\(\) => \[\]\)/);

console.log("Bybit native-protection, HDLX rolling/gutter, S/R alert, and BC-RDA signal regressions passed (no broker mutation performed)." );
