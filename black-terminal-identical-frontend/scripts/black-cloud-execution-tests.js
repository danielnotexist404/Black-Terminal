import assert from "node:assert/strict";
import {
  canonicalize,
  createDeterministicClientOrderId,
  createExecutionIdempotencyKey,
  hashCanonicalPayload,
  signCanonicalPayload,
  verifyCanonicalSignature
} from "../server/cloud-execution/canonical.js";
import { calculateFollowerAllocation, evaluateFollowerRisk, floorToStep } from "../server/cloud-execution/allocation-risk.js";
import { redactObject, sanitizeError } from "../server/cloud-execution/repository.js";
import { createCloudExchangeAdapter, listCloudExchangeAdapters } from "../server/cloud-execution/adapters/registry.js";

process.env.BLACK_CLOUD_INTENT_SIGNING_KEY = "black-terminal-test-signing-key-32-bytes-minimum";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

test("canonical serialization is key-order independent", () => {
  assert.equal(canonicalize({ b: 2, a: { d: 4, c: 3 } }), canonicalize({ a: { c: 3, d: 4 }, b: 2 }));
});

test("server exchange adapter registry exposes the complete Bybit contract", () => {
  const adapter = createCloudExchangeAdapter("bybit", { credentials: { apiKey: "test", apiSecret: "test" }, network: "testnet" });
  assert.deepEqual(listCloudExchangeAdapters(), ["bybit"]);
  for (const operation of ["connect", "authenticate", "getAccount", "getPositions", "getOrders", "placeOrder", "cancelOrder", "modifyOrder", "subscribeMarketData", "subscribePrivateEvents", "reconcile"]) {
    assert.equal(typeof adapter[operation], "function");
  }
});

test("intent signatures reject modified payloads", () => {
  const payload = { groupId: "g1", symbol: "BTCUSDT", quantity: 1 };
  const signature = signCanonicalPayload(payload);
  assert.equal(verifyCanonicalSignature(payload, signature), true);
  assert.equal(verifyCanonicalSignature({ ...payload, quantity: 2 }, signature), false);
});

test("idempotency and venue client IDs are deterministic", () => {
  const input = { groupIntentId: "i", mandateId: "m", connectionId: "c", intentVersion: 1, executionLeg: "primary" };
  const key = createExecutionIdempotencyKey(input);
  assert.equal(key, createExecutionIdempotencyKey({ ...input }));
  const clientOrderId = createDeterministicClientOrderId({ key });
  assert.equal(clientOrderId, createDeterministicClientOrderId({ key }));
  assert.ok(clientOrderId.startsWith("bt-grp-"));
  assert.ok(clientOrderId.length <= 36);
});

test("allocation uses follower equity and venue precision", () => {
  const allocation = calculateFollowerAllocation({
    intent: { quantity_model: "MANDATE_ALLOCATION", quantity_value: 1, leverage: 2 },
    mandate: { allocation_method: "EQUITY_PERCENT", allocation_value: 10, max_order_notional: 5000, max_total_exposure: 10000 },
    account: { equityUsd: 20000, availableBalanceUsd: 5000 },
    instrument: { quantityStep: 0.001, minQuantity: 0.001, minNotional: 5 },
    referencePrice: 64000,
    currentExposure: 0
  });
  assert.equal(allocation.requestedNotional, 2000);
  assert.equal(allocation.roundedQuantity, 0.031);
  assert.equal(allocation.targetNotional, 1984);
  assert.equal(allocation.estimatedMargin, 992);
});

test("allocation cannot exceed margin capacity or mandate limits", () => {
  const allocation = calculateFollowerAllocation({
    intent: { quantity_model: "FIXED_NOTIONAL", quantity_value: 20000, leverage: 2 },
    mandate: { allocation_method: "FIXED_NOTIONAL", allocation_value: 20000, max_order_notional: 10000, max_total_exposure: 8000 },
    account: { equityUsd: 20000, availableBalanceUsd: 1000 },
    instrument: { quantityStep: 0.001, minQuantity: 0.001, minNotional: 5 },
    referencePrice: 100,
    currentExposure: 1000
  });
  assert.equal(allocation.targetNotional, 2000);
  assert.equal(allocation.constrained, true);
});

test("risk rejects local-only and withdrawal-capable connections", () => {
  const risk = evaluateFollowerRisk({
    intent: activeIntent(),
    mandate: activeMandate(),
    connection: { connection_mode: "LOCAL_INTERACTIVE", health_status: "CONNECTED_LOCAL" },
    capabilities: { can_execute_while_offline: false, can_receive_group_orders: false, can_withdraw: true, supported_order_types: ["LIMIT"] },
    allocation: validAllocation()
  });
  assert.equal(risk.status, "REJECTED");
  assert.ok(risk.codes.includes("CONNECTION_NOT_CLOUD"));
  assert.ok(risk.codes.includes("WITHDRAWAL_PERMISSION_FORBIDDEN"));
});

test("risk passes a constrained cloud mandate", () => {
  const risk = evaluateFollowerRisk({
    intent: activeIntent(),
    mandate: activeMandate(),
    connection: { connection_mode: "CLOUD_DELEGATED", health_status: "CONNECTED_CLOUD" },
    capabilities: { can_execute_while_offline: true, can_receive_group_orders: true, can_withdraw: false, supported_order_types: ["LIMIT"] },
    allocation: validAllocation()
  });
  assert.deepEqual(risk, { status: "PASSED", codes: [], reasons: [] });
});

test("pause and emergency-stop block new execution without requiring disconnection", () => {
  for (const control_state of ["PAUSED", "EMERGENCY_STOP"]) {
    const risk = evaluateFollowerRisk({
      intent: activeIntent(),
      mandate: activeMandate(),
      connection: { connection_mode: "CLOUD_DELEGATED", health_status: "CONNECTED_CLOUD", control_state },
      capabilities: { can_execute_while_offline: true, can_receive_group_orders: true, can_withdraw: false, supported_order_types: ["LIMIT"] },
      allocation: validAllocation()
    });
    assert.ok(risk.codes.includes("EXECUTION_CONTROL_STOPPED"));
  }
});

test("precision flooring never rounds risk upward", () => {
  assert.equal(floorToStep(1.239, 0.01), 1.23);
  assert.equal(floorToStep(0.000129, 0.00001), 0.00012);
});

test("audit redaction removes secret-bearing fields", () => {
  const redacted = redactObject({ apiKey: "abc", nested: { signature: "sig", venueOrderId: "safe" } });
  assert.equal(redacted.apiKey, "[REDACTED]");
  assert.equal(redacted.nested.signature, "[REDACTED]");
  assert.equal(redacted.nested.venueOrderId, "safe");
  assert.equal(sanitizeError("apiKey=abc secret:xyz failure"), "apiKey=[REDACTED] secret=[REDACTED] failure");
});

test("hash is stable and does not expose payload", () => {
  const hash = hashCanonicalPayload({ secret: "never-log-me" });
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes("never-log-me"), false);
});

for (const item of cases) {
  await item.run();
  console.log(`PASS ${item.name}`);
}
console.log(`Black Cloud deterministic tests passed: ${cases.length}`);

function activeIntent() {
  return {
    symbol: "BTCUSDT",
    market_type: "PERPETUAL",
    order_type: "LIMIT",
    leverage: 2,
    reduce_only: false,
    valid_from: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString()
  };
}

function activeMandate() {
  return {
    status: "ACTIVE",
    allowed_symbols: ["BTCUSDT"],
    allowed_market_types: ["PERPETUAL"],
    allowed_order_types: ["LIMIT"],
    max_leverage: 2,
    max_total_exposure: 10000,
    max_daily_loss: 1000,
    max_drawdown: 20,
    allow_reduce_only: true
  };
}

function validAllocation() {
  return {
    roundedQuantity: 0.01,
    targetNotional: 640,
    estimatedMargin: 320,
    calculatedAvailableMargin: 1000,
    belowMinimumQuantity: false,
    belowMinimumNotional: false
  };
}
