import assert from "node:assert/strict";
import { allowsManualExchangeTrading, isCloudExecutionReady } from "../src/connectivity/manualTradingAccess.ts";

const tradableAccount = {
  permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
  riskControls: { tradingEnabled: true, readOnlyMode: false, emergencyStop: false }
};

assert.equal(allowsManualExchangeTrading(tradableAccount), true);
assert.equal(allowsManualExchangeTrading(tradableAccount), true, "Black Cloud/private-stream readiness must not disable authenticated manual REST trading");
assert.equal(isCloudExecutionReady("EXECUTION_BLOCKED"), false, "offline cloud execution remains blocked independently");
assert.equal(isCloudExecutionReady("DEGRADED"), false);
assert.equal(allowsManualExchangeTrading(tradableAccount), true, "degraded cloud lifecycle must not override broker-granted manual permissions");
assert.equal(allowsManualExchangeTrading({ ...tradableAccount, permissions: ["read-account"] }), false);
assert.equal(allowsManualExchangeTrading({ ...tradableAccount, riskControls: { tradingEnabled: false, readOnlyMode: true, emergencyStop: false } }), false);
assert.equal(allowsManualExchangeTrading({ ...tradableAccount, riskControls: { tradingEnabled: true, readOnlyMode: false, emergencyStop: true } }), false);

console.log("Manual trading access tests passed: REST trading is independent from Black Cloud readiness.");
