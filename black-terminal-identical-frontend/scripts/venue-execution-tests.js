import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildVenueExecutionSchema,
  calculateVenueOrderPreview,
  calculateVenueSizingCapacity,
  sizeFromEquityPercent,
  sizeFromPositionPercent,
  validateVenueOrderDraft
} from "../src/execution/venueExecutionSchema.ts";
import { executionAlgorithmRegistry } from "../src/execution/executionAlgorithmRegistry.ts";
import { evaluateOrderRisk } from "../src/risk/riskEngine.ts";
import { checkOrderRisk } from "../server/portfolio-api.js";

const connection = {
  id: "cex-acct",
  adapterId: "cex:bybit",
  category: "centralized-exchange",
  provider: "bybit",
  label: "Bybit Prime",
  status: "connected",
  capabilities: ["market-orders", "limit-orders", "conditional-orders", "leverage", "cross-margin", "isolated-margin"],
  accountId: "acct",
  health: {
    status: "connected", latencyMs: 20, heartbeat: "ok", authentication: "authenticated", synchronization: "synced",
    privateStream: "connected", publicStream: "connected", subscriptionCount: 4, reconnectCount: 0,
    permissions: { read: true, trading: true, withdrawal: false, warnings: [] }
  },
  metadata: { network: "mainnet" },
  createdAt: 1,
  updatedAt: 1,
  uptimeMs: 1
};

const sync = {
  accountId: "acct",
  exchange: "bybit",
  network: "mainnet",
  balances: [], positions: [], openOrders: [], externalStateChanged: false, syncedAt: "now", latencyMs: 20,
  accountMetrics: {
    accountType: "UNIFIED", walletBalanceUsd: 100, equityUsd: 105, marginBalanceUsd: 103,
    availableBalanceUsd: 10, initialMarginUsd: 2, maintenanceMarginUsd: 0.5, unrealizedPnlUsd: 3,
    accountImRate: 0.02, accountMmRate: 0.005, updatedAt: 1
  },
  executionState: { tradingEnabled: true, readOnly: false, allowedSymbols: ["SOLUSDT"], maxNotionalUsd: 100, readinessReason: "" },
  accountState: { unifiedMarginStatus: 5, accountGeneration: "UTA2.0", marginMode: "REGULAR_MARGIN", rawMarginMode: "REGULAR_MARGIN", updatedAt: 1 },
  riskLimits: [{ id: 1, symbol: "SOLUSDT", riskLimitValue: 100000, maintenanceMargin: 0.005, initialMargin: 0.05, maxLeverage: 10, lowestRisk: true }],
  priceLimit: { symbol: "SOLUSDT", maximumBuyPrice: 120, minimumSellPrice: 80, updatedAt: 1 },
  instrumentRules: {
    nativeSymbol: "SOLUSDT", canonicalBase: "SOL", canonicalQuote: "USDT", settlementAsset: "USDT",
    tickSize: 0.01, quantityStep: 0.1, minQuantity: 0.1, minNotional: 5, maxQuantity: 100,
    pricePrecision: 2, quantityPrecision: 1, leverageLimits: { min: 1, max: 20, step: 0.5 },
    supportedMarginModes: ["cross", "isolated"], supportedTimeInForce: ["GTC", "IOC", "FOK", "PostOnly"], tradingStatus: "Trading"
  },
  selectedPosition: null
};

const schema = buildVenueExecutionSchema({ connection, product: "perpetual", symbol: "SOLUSDT", sync });

test("schema selects the Bybit provider", () => {
  assert.equal(schema.venue, "bybit");
  assert.equal(schema.marketType, "USDT Perpetual");
  assert.equal(schema.executionReady, true);
});

test("Bybit product capabilities render only ready modes", () => {
  assert.deepEqual(schema.supportedOrderModes.map((mode) => mode.id), ["market", "limit", "conditional", "chase-limit", "twap", "iceberg", "pov"]);
  assert.equal(schema.featureFlags.showLeverage, true);
});

test("unsupported server algorithms stay hidden", () => {
  assert.equal(schema.supportedAlgoStrategies.some((item) => item.id === "blackcore.scaled-order"), false);
  assert.equal(executionAlgorithmRegistry.find((item) => item.id === "blackcore.scaled-order")?.readiness, false);
  assert.equal(schema.supportedAlgoStrategies.find((item) => item.id === "bybit.twap")?.nativeOrSynthetic, "native");
});

test("equity slider converts to a venue-step quantity", () => {
  assert.equal(sizeFromEquityPercent({ schema, percent: 0.5, referencePrice: 100, leverage: 5, sizingMethod: "quantity" }), 0.2);
  assert.equal(sizeFromEquityPercent({ schema, percent: 0.5, referencePrice: 100, leverage: 5, sizingMethod: "usd" }), 24.93);
});

test("equity allocation is calculated before the server safety cap", () => {
  const cappedSchema = { ...schema, maxOrderNotionalUsd: 20 };
  const capacity = calculateVenueSizingCapacity({ schema: cappedSchema, percent: 0.1, referencePrice: 100, leverage: 5 });
  assert.equal(Number(capacity.allocatedNotional.toFixed(2)), 4.99);
  assert.equal(sizeFromEquityPercent({ schema: cappedSchema, percent: 0.1, referencePrice: 100, leverage: 5, sizingMethod: "usd" }), 4.99);
});

test("an impossible server cap is distinguished from account balance", () => {
  const btcSchema = {
    ...schema,
    maxOrderNotionalUsd: 5,
    instrumentRules: { ...schema.instrumentRules, symbol: "BTCUSDT", minQuantity: 0.001, minNotional: 5, quantityStep: 0.001 }
  };
  const capacity = calculateVenueSizingCapacity({ schema: btcSchema, percent: 1, referencePrice: 65759.4, leverage: 35 });
  assert.equal(capacity.venueMinimumNotional, 65.7594);
  assert.equal(capacity.blockedByServerCap, true);
  assert.equal(capacity.availableMargin, 10);
});

test("reduce-only slider sizes from the current position", () => {
  assert.equal(sizeFromPositionPercent(schema, 7.37, 0.5), 3.6);
});

test("minimum notional and leverage constraints are deterministic", () => {
  const result = validateVenueOrderDraft({ schema, orderType: "market", sizingMethod: "quantity", size: 0.1, referencePrice: 10, leverage: 25, side: "buy", reduceOnly: false, tpSlEnabled: false });
  assert.equal(result.valid, false);
  assert.match(result.reasons.join(" "), /Minimum SOLUSDT order value|Leverage must be/);
});

test("risk tier and price bands constrain the ticket", () => {
  assert.equal(schema.instrumentRules.maxLeverage, 10);
  const result = validateVenueOrderDraft({ schema, orderType: "limit", sizingMethod: "quantity", size: 1, referencePrice: 100, limitPrice: 121, leverage: 5, side: "buy", reduceOnly: false, tpSlEnabled: false });
  assert.equal(result.valid, false);
  assert.match(result.reasons.join(" "), /price limit/);
});

test("order-mode fields remain product-specific", () => {
  assert.deepEqual(schema.supportedOrderModes.find((mode) => mode.id === "market")?.fields, ["quantity", "slippageTolerance", "reduceOnly", "tpSl"]);
  assert.equal(schema.supportedOrderModes.find((mode) => mode.id === "limit")?.fields.includes("price"), true);
  assert.equal(schema.supportedOrderModes.find((mode) => mode.id === "conditional")?.fields.includes("triggerBy"), true);
  assert.equal(schema.supportedOrderModes.find((mode) => mode.id === "pov")?.fields.includes("participationRate"), true);
});

test("native strategy validation rejects incomplete TWAP", () => {
  const result = validateVenueOrderDraft({ schema, orderType: "twap", sizingMethod: "quantity", size: 1, referencePrice: 100, leverage: 5, side: "buy", reduceOnly: false, tpSlEnabled: false, strategyParameters: { durationSeconds: 60, intervalSeconds: 7 } });
  assert.equal(result.valid, false);
  assert.match(result.reasons.join(" "), /TWAP duration|TWAP interval/);
});

test("reduce-only and attached TP/SL are rejected", () => {
  const result = validateVenueOrderDraft({ schema, orderType: "limit", sizingMethod: "quantity", size: 1, referencePrice: 100, limitPrice: 100, leverage: 5, side: "buy", reduceOnly: true, tpSlEnabled: true });
  assert.equal(result.valid, false);
  assert.match(result.reasons.join(" "), /Reduce-Only/);
});

test("preview calculates margin, fees, and reward-risk", () => {
  const preview = calculateVenueOrderPreview({ schema, sizingMethod: "quantity", size: 1, referencePrice: 100, leverage: 5, side: "buy", stopLoss: 95, takeProfit: 110 });
  assert.equal(preview.notional, 100);
  assert.equal(preview.requiredMargin, 20);
  assert.equal(preview.rewardRiskRatio, 2);
});

test("zero risk ceilings delegate capacity to live account margin", () => {
  const controls = {
    maxLeverage: 100,
    maxPositionUsd: 0,
    maxDailyLossUsd: 10000,
    maxPortfolioExposureUsd: 0,
    allowedSymbols: ["BTCUSDT"],
    readOnlyMode: false,
    tradingEnabled: true,
    emergencyStop: false
  };
  const account = {
    id: "acct", exchange: "bybit", label: "Bybit", accountName: "Bybit", permissions: [], isPaper: false,
    connectedAt: 1, lastValidatedAt: 1, status: "connected", apiHealth: "healthy", latencyMs: 1,
    balanceUsd: 20000, equityUsd: 20000, marginUsed: 0, availableMargin: 20000, buyingPower: 700000,
    leverage: 35, dailyPnl: 0, monthlyPnl: 0, openPositions: 0, openOrders: 0, riskControls: controls
  };
  const order = {
    clientOrderId: "order", accountId: "acct", exchange: "bybit", symbol: "BTCUSDT", marketKind: "perpetual",
    side: "buy", orderType: "limit", quantity: 680000, sizingMethod: "usd", limitPrice: 65000,
    referencePrice: 65000, timeInForce: "gtc", leverage: 35, destinations: ["personal-portfolio"], source: "order-ticket"
  };
  assert.equal(evaluateOrderRisk(order, account, controls, 65000).status, "approved");
});

test("portfolio exposure compares margin to margin instead of notional", () => {
  const result = checkOrderRisk({
    account: { is_read_only: false, trading_enabled: true },
    riskControls: {
      read_only_mode: false, trading_enabled: true, emergency_stop: false, allowed_symbols: ["BTCUSDT"],
      max_position_usd: 0, max_portfolio_exposure_usd: 25000, max_daily_loss_usd: 10000
    },
    order: { symbol: "BTCUSDT", marketKind: "perpetual", quantity: 680000, quantityMode: "usd", referencePrice: 65000, leverage: 35 },
    accountExposureUsd: 1000,
    dailyPnl: 0
  });
  assert.equal(result.status, "approved");
  assert.equal(Number(result.requiredMargin.toFixed(2)), 19428.57);
});

test("normal ticket contains no certification activation controls", () => {
  const source = fs.readFileSync(new URL("../src/execution/components/UnifiedExecutionTicket.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ENABLE BYBIT TRADING|ENABLE LIVE MODE|ENABLE LIVE BYBIT VALIDATION/);
});

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
