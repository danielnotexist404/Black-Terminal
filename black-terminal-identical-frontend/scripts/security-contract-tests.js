import assert from "node:assert/strict";
import { enforcePayloadLimit } from "../server/security/securityMiddleware.js";
import { isAllowedOrigin } from "../server/security/http-security.js";
import { tradingSchemasForTests, validateTradingRequest } from "../server/security/trading-schemas.js";
import { sanitizeAuditMetadata, sanitizeAuditText } from "../server/security/audit-safety.js";
import { normalizeCloudPath } from "../api/cloud-execution/[...path].js";

const accountId = "account-123";
const order = {
  accountId,
  exchange: "bybit",
  symbol: "BTCUSDT",
  marketKind: "perpetual",
  side: "buy",
  orderType: "limit",
  quantity: 0.01,
  limitPrice: 65000,
  mainnetConfirmed: false
};

assert.deepEqual(normalizeCloudPath(undefined, { url: "/api/cloud-execution/status" }), ["status"]);
assert.deepEqual(normalizeCloudPath(["control"], { url: "/ignored" }), ["control"]);

const validCases = [
  ["execution", "order", order],
  ["execution", "cancel", { orderId: "order-123", accountId, symbol: "BTCUSDT" }],
  ["execution", "modify", { orderId: "order-123", accountId, symbol: "BTCUSDT", quantity: 0.02 }],
  ["execution", "cancel-all", { accountId, symbol: "BTCUSDT" }],
  ["execution", "position-action", { accountId, symbol: "BTCUSDT", action: "close", quantity: 0.01 }],
  ["execution", "protection", { accountId, symbol: "BTCUSDT", stopLoss: 60000 }],
  ["execution", "account-mode", { accountId, action: "set-leverage", symbol: "BTCUSDT", leverage: 2 }],
  ["execution", "strategy", { accountId, strategyId: "strategy-123", symbol: "BTCUSDT" }],
  ["exchange", "connect", { exchange: "bybit", accountName: "Main", apiKey: "key-12345", apiSecret: "secret-12345" }],
  ["exchange", "diagnostics", { accountId, symbol: "BTCUSDT" }],
  ["exchange", "sync", { accountId, symbol: "BTCUSDT", marketKind: "perpetual" }],
  ["exchange", "mainnet-validation", { accountId, action: "enable", confirmation: "ENABLE BYBIT MAINNET" }],
  ["hyperliquid", "connect", { masterWalletAddress: "0x1234567890", agentPrivateKey: "private-12345", network: "testnet" }],
  ["hyperliquid", "order", { ...order, exchange: "hyperliquid" }],
  ["hyperliquid", "modify", { ...order, exchange: "hyperliquid", orderId: "order-123" }],
  ["hyperliquid", "cancel", { accountId, symbol: "BTCUSDT", orderId: "order-123" }],
  ["hyperliquid", "close-position", { accountId, symbol: "BTCUSDT", quantity: 0.01 }],
  ["hyperliquid", "sync", { accountId }],
  ["cloud", "connection", { accountId, confirmation: "ENABLE OFFLINE CLOUD EXECUTION" }],
  ["cloud", "control", { connectionId: "connection-123", action: "pause" }],
  ["cloud", "control", { connectionId: "connection-123", action: "resume" }],
  ["cloud", "control", { connectionId: "connection-123", action: "emergency-stop", reason: "operator requested" }],
  ["cloud", "intent", {
    groupId: "group-123",
    clientIntentId: "intent-123",
    symbol: "BTCUSDT",
    marketType: "perpetual",
    side: "buy",
    orderType: "limit",
    limitPrice: 65000,
    quantityModel: "fixed",
    quantityValue: 0.01,
    expiresAt: "2026-07-21T00:00:00.000Z"
  }],
  ["cloud", "mandate", {
    action: "create",
    groupId: "group-123",
    connectionId: "connection-123",
    allocationMethod: "fixed",
    allocationValue: 1000,
    maxOrderNotional: 500,
    maxTotalExposure: 2000,
    maxDailyLoss: 100,
    maxDrawdown: 250,
    maxLeverage: 3,
    allowedSymbols: ["BTCUSDT"],
    allowedMarketTypes: ["PERPETUAL"],
    allowedOrderTypes: ["LIMIT"]
  }],
  ["cloud", "mandate", { action: "accept", mandateId: "mandate-123", confirmation: "AUTHORIZE OFFLINE GROUP EXECUTION" }],
  ["cloud", "mandate", { action: "pause", mandateId: "mandate-123" }],
  ["cloud", "mandate", { action: "revoke", mandateId: "mandate-123" }]
];

for (const [family, action, body] of validCases) {
  const req = { method: "POST", body: structuredClone(body) };
  validateTradingRequest(req, family, action);
  assert.deepEqual(req.body, body, `${family}.${action} must accept its documented payload`);
}

for (const [family, action, body] of validCases) {
  const result = tradingSchemasForTests[family][action].safeParse({ ...body, unexpected: true });
  assert.equal(result.success, false, `${family}.${action} must reject unknown fields`);
}

assert.equal(tradingSchemasForTests.execution.order.safeParse({ ...order, side: "hold" }).success, false);
assert.equal(tradingSchemasForTests.execution.order.safeParse({ ...order, quantity: -1 }).success, false);
assert.equal(tradingSchemasForTests.cloud.connection.safeParse({ accountId, confirmation: "yes" }).success, false);
assert.equal(tradingSchemasForTests.cloud.mandate.safeParse({ action: "accept", mandateId: "mandate-123", confirmation: "yes" }).success, false);

enforcePayloadLimit({ headers: {}, body: { safe: true } }, 1024);
assert.throws(() => enforcePayloadLimit({ headers: { "content-length": "2048" }, body: {} }, 1024), /too large/i);
assert.throws(() => enforcePayloadLimit({ headers: {}, body: [] }, 1024), /must be an object/i);
let nested = {};
for (let index = 0; index < 12; index += 1) nested = { nested };
assert.throws(() => enforcePayloadLimit({ headers: {}, body: nested }, 4096), /deeply nested/i);

assert.equal(sanitizeAuditText("token=abc123"), "token=[REDACTED]");
assert.equal(sanitizeAuditText("re_abcdefghijklmnopqrstuvwxyz123456"), "[REDACTED_PROVIDER_KEY]");
assert.deepEqual(
  sanitizeAuditMetadata({ action: "connect", nested: { apiKey: "never-store", result: "blocked" }, prompt: "never-store" }),
  { action: "connect", nested: { apiKey: "[REDACTED]", result: "blocked" }, prompt: "[REDACTED]" }
);

const previousNodeEnv = process.env.NODE_ENV;
const previousDevelopmentOverride = process.env.ALLOW_DEVELOPMENT_ORIGINS;
try {
  process.env.NODE_ENV = "production";
  delete process.env.ALLOW_DEVELOPMENT_ORIGINS;
  assert.equal(isAllowedOrigin("https://www.black-terminal.live"), true);
  assert.equal(isAllowedOrigin("tauri://localhost"), true);
  assert.equal(isAllowedOrigin("https://tauri.localhost"), true);
  assert.equal(isAllowedOrigin("http://localhost:5173"), false);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  process.env.NODE_ENV = "development";
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:1420"), true);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
} finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDevelopmentOverride === undefined) delete process.env.ALLOW_DEVELOPMENT_ORIGINS;
  else process.env.ALLOW_DEVELOPMENT_ORIGINS = previousDevelopmentOverride;
}

console.log(`Security contract tests passed: ${validCases.length} route contracts plus negative-envelope and CORS controls.`);
