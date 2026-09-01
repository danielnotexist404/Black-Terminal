import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategySignals } from "../src/modules/strategy-lab/adapters/signalAdapter.ts";
import {
  applyAutomationDefinitionToConfig,
  automationTimeframes,
  certifiedStrategyEngines,
  definitionFingerprint,
  marketSymbolFromBacktestConfig,
  validateAutomationDefinition,
} from "../src/modules/strategy-lab/automation/strategyDefinitionModel.ts";
import { defaultStrategySettings } from "../src/modules/strategy-lab/types/strategy.types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const initial = {
  symbol: "ETHUSDT",
  rawSymbol: "ETHUSDT",
  exchange: "binance" as const,
  exchangeLabel: "Binance",
  marketKind: "perpetual" as const,
  timeframe: "15m" as const,
  startDate: "2026-08-01",
  endDate: "2026-08-23",
  initialCapital: 10_000,
  riskPerTrade: 0.01,
  feeRate: 0.0004,
  slippageTicks: 2,
  tickSize: 0.1,
  spreadBps: 1.5,
  useBidAskExecution: true,
  maxTradesPerDay: 8,
  maxDailyLoss: 250,
  maxDrawdown: 0.2,
  maxOpenPositions: 1,
  maxLeverage: 3,
  cooldownAfterLosses: 3,
  disableOnHighSpreadBps: 8,
  disableOnLowLiquidity: true,
  disableOnAbnormalVolatility: true,
  fundingRatePerDay: 0,
  strategyKind: "builtin-adaptive-swing" as const,
  strategySettings: defaultStrategySettings,
};
const definition = {
  runtimeKind: "builtin-adaptive-swing" as const,
  symbol: "XMRUSDT",
  timeframe: "4h",
  marketType: "FUTURES" as const,
  exchange: "bybit",
  settings: {
    ...defaultStrategySettings,
    swingLookback: 72,
    stopLossPercent: 1.25,
  },
  execution: {
    feeRate: 0.00055,
    slippageTicks: 4,
    tickSize: 0.01,
    maxTradesPerDay: 5,
    disableOnLowLiquidity: false,
  },
};

const hydrated = applyAutomationDefinitionToConfig(initial, definition);
assert.equal(hydrated.symbol, "XMRUSDT");
assert.equal(hydrated.rawSymbol, "XMRUSDT");
assert.equal(hydrated.exchange, "bybit");
assert.equal(hydrated.exchangeLabel, "Bybit");
assert.equal(hydrated.marketKind, "perpetual");
assert.equal(hydrated.timeframe, "4h");
assert.equal(hydrated.strategyKind, "builtin-adaptive-swing");
assert.equal(hydrated.strategySettings.swingLookback, 72);
assert.equal(hydrated.strategySettings.stopLossPercent, 1.25);
assert.equal(hydrated.feeRate, 0.00055);
assert.equal(hydrated.slippageTicks, 4);
assert.equal(hydrated.tickSize, 0.01);
assert.equal(hydrated.maxTradesPerDay, 5);
assert.equal(hydrated.disableOnLowLiquidity, false);

const selectedMarket = marketSymbolFromBacktestConfig(hydrated);
assert.deepEqual(
  {
    exchange: selectedMarket.exchange,
    rawSymbol: selectedMarket.rawSymbol,
    baseAsset: selectedMarket.baseAsset,
    quoteAsset: selectedMarket.quoteAsset,
    marketKind: selectedMarket.marketKind,
  },
  {
    exchange: "bybit",
    rawSymbol: "XMRUSDT",
    baseAsset: "XMR",
    quoteAsset: "USDT",
    marketKind: "perpetual",
  },
);

assert.equal(certifiedStrategyEngines.length, 3);
assert.deepEqual(
  certifiedStrategyEngines.map((item) => item.value),
  ["builtin-superatr-seven-step", "builtin-adaptive-swing", "builtin-ema-cross"],
);
assert.ok(automationTimeframes.includes("4h"));
assert.ok(automationTimeframes.includes("1d"));
assert.equal(validateAutomationDefinition(definition), null);
assert.match(
  validateAutomationDefinition({ ...definition, exchange: "binance" }) || "",
  /Bybit only/,
);
assert.match(
  validateAutomationDefinition({ ...definition, runtimeKind: "python-script" }) || "",
  /certified headless signal adapter/,
);
const blackScriptDefinition = {
  ...definition,
  runtimeKind: "python-script" as const,
  indicator: {
    indicatorId: "custom:owned-script",
    instanceId: "custom:owned-script",
    name: "Owned Script",
    version: "12345678",
    settingsHash: "87654321",
    alertManifestVersion: "custom:1",
    runtimeVersion: "black-script-v3",
    runtimeStatus: "CERTIFIED" as const,
    warmupBars: 500,
    useCurrentChartSettings: false,
    alerts: [],
  },
};
assert.equal(validateAutomationDefinition(blackScriptDefinition), null);
assert.match(validateAutomationDefinition({ ...blackScriptDefinition, marketType: "SPOT" }) || "", /futures targets only/);
assert.match(validateAutomationDefinition({
  ...blackScriptDefinition,
  controlPanel: { schemaVersion: 2, properties: { pyramiding: 2 } } as never,
}) || "", /pyramiding set to 1/);
assert.match(
  validateAutomationDefinition({
    ...definition,
    runtimeKind: "builtin-ema-cross",
    settings: { ...definition.settings, emaFastLength: 100, emaSlowLength: 50 },
  }) || "",
  /EMA Fast/,
);

assert.equal(
  definitionFingerprint(definition),
  definitionFingerprint({
    ...definition,
    settings: Object.fromEntries(
      Object.entries(definition.settings).reverse(),
    ) as typeof definition.settings,
  }),
  "definition identity is stable when object key order changes",
);
assert.notEqual(
  definitionFingerprint(definition),
  definitionFingerprint({ ...definition, timeframe: "1d" }),
);

assert.throws(
  () =>
    createStrategySignals(
      "external-signals",
      [],
      "BTCUSDT",
      defaultStrategySettings,
    ),
  /does not have a certified Strategy Lab signal adapter/,
  "pending runtimes cannot silently execute EMA Cross",
);

const builder = fs.readFileSync(
  path.join(
    root,
    "src/modules/strategy-lab/automation/StrategyDefinitionBuilder.tsx",
  ),
  "utf8",
);
const panel = fs.readFileSync(
  path.join(
    root,
    "src/modules/strategy-lab/automation/StrategyAutomationPanel.tsx",
  ),
  "utf8",
);
const page = fs.readFileSync(
  path.join(root, "src/modules/strategy-lab/components/StrategyLabPage.tsx"),
  "utf8",
);
for (const control of [
  "Strategy market type",
  "Strategy timeframe",
  "Strategy symbol",
  "INDICATOR PARAMETERS",
  "EXECUTION &amp; RISK GUARDS",
]) {
  assert.match(builder, new RegExp(control));
}
assert.match(panel, /onDefinitionChange\(next\.strategy\.definition\)/);
assert.match(page, /marketSymbolFromBacktestConfig\(config\)/);
assert.doesNotMatch(
  builder,
  /placeOrder|cancelOrder|modifyOrder/,
  "the definition editor contains no broker mutation path",
);

console.log(
  "Strategy definition builder tests PASS — certified engine selection, live Bybit market controls, saved-definition hydration, dynamic backtest market routing, parameter persistence and unsupported-runtime fail-closed behavior verified.",
);
