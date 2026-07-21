import assert from "node:assert/strict";
import { calculateFollowerAllocation, evaluateFollowerRisk } from "../server/cloud-execution/allocation-risk.js";

const intent = { symbol: "BTCUSDT", market_type: "PERPETUAL", order_type: "LIMIT", leverage: 2, reduce_only: false, valid_from: new Date(Date.now()-1000).toISOString(), expires_at: new Date(Date.now()+60000).toISOString() };
const mandate = { status: "ACTIVE", allocation_method: "EQUITY_PERCENT", allocation_value: 5, max_order_notional: 10000, max_total_exposure: 20000, max_daily_loss: 500, max_drawdown: 20, max_leverage: 3, allowed_symbols: ["BTCUSDT"], allowed_market_types: ["PERPETUAL"], allowed_order_types: ["LIMIT"], allow_reduce_only: true };
const allocation = calculateFollowerAllocation({ intent: { ...intent, quantity_model: "MANDATE_ALLOCATION", quantity_value: 1 }, mandate, account: { equityUsd: 5000, availableBalanceUsd: 2000 }, instrument: { quantityStep: 0.001, minQuantity: 0.001, minNotional: 5 }, referencePrice: 50000 });
assert.equal(allocation.requestedNotional, 250);
assert.equal(allocation.roundedQuantity, 0.005);
const risk = evaluateFollowerRisk({ intent, mandate, connection: { connection_mode: "CLOUD_DELEGATED", health_status: "CONNECTED_CLOUD", control_state: "ACTIVE" }, capabilities: { can_execute_while_offline: true, can_receive_group_orders: true, can_withdraw: false, supported_order_types: ["LIMIT"] }, allocation });
assert.equal(risk.status, "PASSED");
console.log("Investor execution tests passed: proportional equity allocation and pre-execution risk.");
