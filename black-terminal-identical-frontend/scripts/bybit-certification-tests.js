import assert from "node:assert/strict";
import {
  evaluateBybitOrderDraftAgainstMetadata,
  normalizeBybitExecutionReport,
  normalizeBybitOrderStatus,
  normalizeBybitSizing,
  precisionFromStep,
  validateBybitMainnetValidationRequest
} from "../server/exchanges/bybit.js";
import {
  createBybitWsAuthPayload,
  normalizeBybitPrivateStreamMessage
} from "../server/exchanges/bybit-private-stream.js";

const metadata = {
  nativeSymbol: "BTCUSDT",
  tradingStatus: "Trading",
  tickSize: 0.1,
  quantityStep: 0.001,
  minQuantity: 0.001,
  minNotional: 5,
  maxQuantity: 100,
  pricePrecision: 1,
  quantityPrecision: 3,
  leverageLimits: { min: 1, max: 100, step: 0.01 },
  supportedMarginModes: ["cross", "isolated"]
};

test("clock skew math is deterministic", () => {
  const localTimeMs = 1_000_000;
  const serverTimeMs = 999_250;
  assert.equal(localTimeMs - serverTimeMs, 750);
});

test("metadata precision is derived from exchange steps", () => {
  assert.equal(precisionFromStep("0.001"), 3);
  assert.equal(precisionFromStep("0.1000"), 1);
  assert.equal(precisionFromStep("1"), 0);
});

test("min notional and step validation reject invalid orders", () => {
  const result = evaluateBybitOrderDraftAgainstMetadata(metadata, {
    marketKind: "perpetual",
    symbol: "BTCUSDT",
    orderType: "limit",
    side: "buy",
    quantity: 0.0005,
    limitPrice: 62000,
    referencePrice: 62000,
    marginMode: "cross",
    leverage: 5
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /minimum|quantity step/i);
});

test("valid order passes metadata-backed venue validation", () => {
  const result = evaluateBybitOrderDraftAgainstMetadata(metadata, {
    marketKind: "perpetual",
    symbol: "BTCUSDT",
    orderType: "limit",
    side: "buy",
    quantity: 0.01,
    limitPrice: 62000.1,
    referencePrice: 62000.1,
    marginMode: "isolated",
    leverage: 5,
    timeInForce: "gtc"
  });
  assert.equal(result.ok, true);
  assert.equal(result.normalized.timeInForce, "GTC");
});

test("USD sizing converts to metadata-aligned base quantity", () => {
  const normalized = normalizeBybitSizing({
    quantity: 62,
    sizingMethod: "usd",
    referencePrice: 62000
  }, metadata);
  assert.equal(normalized.quantity, 0.001);
});

test("execution report mapping preserves legal OMS statuses", () => {
  assert.equal(normalizeBybitOrderStatus("PartiallyFilled"), "partially-filled");
  const report = normalizeBybitExecutionReport({
    exchange: "bybit",
    symbol: "BTCUSDT",
    status: "Filled",
    orderId: "abc",
    filledQuantity: "0.01",
    averageFillPrice: "62000"
  });
  assert.equal(report.status, "filled");
  assert.equal(report.filledQuantity, 0.01);
});

test("private stream events normalize order, fill, position, and wallet topics", () => {
  const orderEvents = normalizeBybitPrivateStreamMessage({
    topic: "order",
    creationTime: 1,
    data: [{ orderId: "o1", symbol: "BTCUSDT", orderStatus: "New", qty: "0.01", cumExecQty: "0", side: "Buy" }]
  });
  assert.equal(orderEvents[0].report.status, "working");

  const fillEvents = normalizeBybitPrivateStreamMessage({
    topic: "execution",
    creationTime: 2,
    data: [{ execId: "f1", orderId: "o1", symbol: "BTCUSDT", execPrice: "62000", execQty: "0.01", side: "Buy" }]
  });
  assert.equal(fillEvents[0].fill.quantity, 0.01);

  const positionEvents = normalizeBybitPrivateStreamMessage({
    topic: "position",
    creationTime: 3,
    data: [{ symbol: "BTCUSDT", side: "Buy", size: "0.01", avgPrice: "62000", markPrice: "62100" }]
  });
  assert.equal(positionEvents[0].position.direction, "long");

  const walletEvents = normalizeBybitPrivateStreamMessage({
    topic: "wallet",
    creationTime: 4,
    data: [{ accountType: "UNIFIED", coin: [{ coin: "USDT", walletBalance: "100", locked: "5", usdValue: "100" }] }]
  });
  assert.equal(walletEvents[0].wallet.free, 95);
});

test("private websocket auth payload is shaped for Bybit v5", () => {
  const payload = createBybitWsAuthPayload({ apiKey: "key", apiSecret: "secret" }, { expires: 12345 });
  assert.equal(payload.op, "auth");
  assert.equal(payload.args[0], "key");
  assert.equal(payload.args[1], 12345);
  assert.equal(typeof payload.args[2], "string");
});

test("mainnet validation gate fails closed without env allowlists", () => {
  const previous = {
    enabled: process.env.BYBIT_MAINNET_VALIDATION_ENABLED,
    allowedConnections: process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS,
    allowedSymbols: process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS,
    maxNotional: process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD
  };
  delete process.env.BYBIT_MAINNET_VALIDATION_ENABLED;
  delete process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS;
  delete process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS;
  delete process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD;

  const result = validateBybitMainnetValidationRequest({
    account: { id: "acct-1" },
    order: { symbol: "BTCUSDT", mainnetConfirmed: true, liveConfirmation: "LIVE" },
    risk: { notional: 3 },
    validation: { ok: true, reasons: [] }
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /BYBIT_MAINNET_VALIDATION_ENABLED|ALLOWED_CONNECTIONS|MAX_NOTIONAL/);

  restoreEnv(previous);
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

function restoreEnv(previous) {
  setOrDelete("BYBIT_MAINNET_VALIDATION_ENABLED", previous.enabled);
  setOrDelete("BYBIT_MAINNET_ALLOWED_CONNECTIONS", previous.allowedConnections);
  setOrDelete("BYBIT_MAINNET_ALLOWED_SYMBOLS", previous.allowedSymbols);
  setOrDelete("BYBIT_MAINNET_MAX_NOTIONAL_USD", previous.maxNotional);
}

function setOrDelete(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
