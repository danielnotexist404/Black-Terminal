import assert from "node:assert/strict";
import { allowsManualExchangeTrading, isCloudExecutionReady } from "../src/connectivity/manualTradingAccess.ts";

const tradableAccount = {
  permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
  riskControls: { tradingEnabled: true, readOnlyMode: false, emergencyStop: false }
};

assert.equal(allowsManualExchangeTrading(tradableAccount, "CONNECTED_TRADING"), true);
assert.equal(allowsManualExchangeTrading(tradableAccount, "EXECUTION_BLOCKED"), true, "Black Cloud/private-stream readiness must not disable authenticated manual REST trading");
assert.equal(isCloudExecutionReady("EXECUTION_BLOCKED"), false, "offline cloud execution remains blocked independently");
assert.equal(allowsManualExchangeTrading(tradableAccount, "CONNECTED_READ_ONLY"), false);
assert.equal(allowsManualExchangeTrading(tradableAccount, "AUTHENTICATION_ERROR"), false);
assert.equal(allowsManualExchangeTrading({ ...tradableAccount, permissions: ["read-account"] }, "EXECUTION_BLOCKED"), false);
assert.equal(allowsManualExchangeTrading({ ...tradableAccount, riskControls: { tradingEnabled: false, readOnlyMode: true, emergencyStop: false } }, "EXECUTION_BLOCKED"), false);
assert.equal(allowsManualExchangeTrading({ ...tradableAccount, riskControls: { tradingEnabled: true, readOnlyMode: false, emergencyStop: true } }, "EXECUTION_BLOCKED"), false);

console.log("Manual trading access tests passed: REST trading is independent from Black Cloud readiness.");
