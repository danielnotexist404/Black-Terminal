import assert from "node:assert/strict";
import fs from "node:fs";
import {
  latestBindingExecutionTelemetry,
  latestRowsByKey,
  preflightInvestmentGroupFollowerExecution,
} from "../server/strategy-automation/repository.js";

const checkedAt = "2026-08-31T05:00:00.000Z";
const binding = {
  id: "binding-group-1",
  strategy_id: "strategy-1",
  strategy_version: 6,
  market_type: "FUTURES",
  strategy_allocation_mode: "PERCENT_ACCOUNT_EQUITY",
  strategy_allocation_value: 100,
  trade_amount_mode: "PERCENT_ACCOUNT_EQUITY",
  trade_amount_value: 10,
  requested_leverage: 5,
  requested_long_leverage: 5,
  requested_short_leverage: 5,
  maximum_leverage: 20,
  maximum_position_percent: 100,
  maximum_exposure_percent: 100,
  maximum_daily_loss: 100,
  maximum_drawdown: 20,
  maximum_positions: 1,
  slippage_bps: 5,
  margin_mode: "CROSS",
};
const mandate = {
  id: "mandate-1",
  follower_user_id: "follower-1",
  broker_connection_id: "connection-1",
  status: "ACTIVE",
  execution_mode: "CLOUD_DELEGATED",
  allocation_method: "EQUITY_PERCENT",
  allocation_value: 100,
  max_order_notional: 5_000,
  max_total_exposure: 5_000,
  max_daily_loss: 100,
  max_drawdown: 20,
  max_leverage: 10,
  allowed_symbols: ["BTCUSDT"],
  allowed_market_types: ["PERPETUAL"],
  allowed_order_types: ["MARKET", "LIMIT"],
  allow_reduce_only: true,
  allow_open_positions: true,
  allow_close_positions: true,
};
const connection = {
  id: "connection-1",
  user_id: "follower-1",
  provider: "bybit",
  account_id: "account-1",
  connection_mode: "CLOUD_DELEGATED",
  health_status: "CONNECTED_CLOUD",
  credential_state: "AUTHENTICATED",
  worker_state: "LIVE",
  synchronization_state: "SYNCHRONIZED",
  execution_readiness: "READY",
  execution_environment: "MAINNET_LIVE",
  control_state: "ACTIVE",
};
const capability = {
  connection_id: "connection-1",
  can_execute_while_offline: true,
  can_receive_group_orders: true,
  can_withdraw: false,
  can_transfer: false,
  supported_order_types: ["MARKET", "LIMIT"],
};
const automationMandate = {
  id: "automation-mandate-1",
  user_id: "follower-1",
  connection_id: "connection-1",
  status: "ACTIVE",
  allow_strategy_execution: true,
  allow_investment_group_execution: true,
  allow_withdrawals: false,
  max_order_notional: 5_000,
  max_position_notional: 5_000,
  max_leverage: 10,
  allowed_strategies: ["strategy-1"],
  allowed_symbols: ["BTCUSDT"],
};
const account = { id: "account-1", user_id: "follower-1", is_read_only: false, trading_enabled: true };
const accountEquity = {
  account_id: "account-1",
  user_id: "follower-1",
  equity_usd: 1_000,
  available_balance_usd: 900,
  observed_at: checkedAt,
  captured_at: checkedAt,
};
const instrument = {
  nativeSymbol: "BTCUSDT",
  tradingStatus: "Trading",
  quantityStep: 0.001,
  quantityPrecision: 3,
  minQuantity: 0.001,
  minNotional: 5,
  maxQuantity: 100,
  maxMarketQuantity: 50,
  leverageLimits: { max: 100 },
};
const takeProfitPercentages = [10, 10, 10, 10, 10, 10, 10];
const marketSnapshot = {
  instrument,
  referencePrice: 100,
  takeProfitPricing: {
    basis: "TEST_EXACT_PRICES",
    directions: {
      long: { prices: [101, 102, 103, 104, 105, 106, 107] },
      short: { prices: [99, 98, 97, 96, 95, 94, 93] },
    },
  },
};

const successful = preflightInvestmentGroupFollowerExecution({
  checkedAt,
  binding,
  definition: { runtimeKind: "builtin-superatr-seven-step" },
  symbol: "BTCUSDT",
  mandate,
  connection,
  capability,
  automationMandate,
  account,
  accountEquity,
  riskControl: { account_id: "account-1", max_leverage: 20, emergency_stop: false },
  positions: [],
  marketSnapshot,
  takeProfitPercentages,
});
assert.equal(successful.ok, true, "a fully authorized, funded follower passes both entry directions and all seven TP minimums");
assert.equal(successful.directions.long.fullLadder.feasible, true);
assert.equal(successful.directions.short.fullLadder.feasible, true);
assert.equal(successful.directions.long.allocation.roundedQuantity, 10, "preflight uses the same mandate allocation quantity as the group worker");

const undersized = preflightInvestmentGroupFollowerExecution({
  checkedAt,
  binding,
  definition: { runtimeKind: "builtin-superatr-seven-step" },
  symbol: "BTCUSDT",
  mandate: { ...mandate, id: "mandate-small", allocation_value: 0.1 },
  connection,
  capability,
  automationMandate,
  account,
  accountEquity,
  riskControl: { account_id: "account-1", max_leverage: 20, emergency_stop: false },
  positions: [],
  marketSnapshot,
  takeProfitPercentages,
});
assert.equal(undersized.ok, false, "one undersized follower fails closed instead of allowing group activation");
assert.ok(Object.values(undersized.directions).every((report) => report.ok === false));
assert.match(undersized.reasons.join(" "), /minimum|quantity|notional/i);

const cappedLeverage = preflightInvestmentGroupFollowerExecution({
  checkedAt,
  binding,
  definition: {},
  symbol: "BTCUSDT",
  mandate: { ...mandate, id: "mandate-capped", max_leverage: 3 },
  connection,
  capability,
  automationMandate,
  account,
  accountEquity,
  riskControl: { account_id: "account-1", max_leverage: 20, emergency_stop: false },
  positions: [],
  marketSnapshot: { ...marketSnapshot, takeProfitPricing: null },
  takeProfitPercentages: [],
});
assert.equal(cappedLeverage.ok, false, "requested leverage above one follower mandate cap blocks the whole follower report");
assert.match(cappedLeverage.reasons.join(" "), /5x leverage exceeds.*3x/i);

const staleEquity = preflightInvestmentGroupFollowerExecution({
  checkedAt,
  binding,
  definition: {},
  symbol: "BTCUSDT",
  mandate,
  connection,
  capability,
  automationMandate,
  account,
  accountEquity: { ...accountEquity, observed_at: "2026-08-31T04:00:00.000Z", captured_at: "2026-08-31T04:00:00.000Z" },
  marketSnapshot: { ...marketSnapshot, takeProfitPricing: null },
  takeProfitPercentages: [],
});
assert.equal(staleEquity.ok, false);
assert.match(staleEquity.reasons.join(" "), /fresh authoritative follower equity/i);

const latestEquities = latestRowsByKey([
  { account_id: "a", observed_at: "2026-08-31T04:59:00.000Z", equity_usd: 1 },
  { account_id: "b", captured_at: "2026-08-31T04:58:00.000Z", equity_usd: 2 },
  { account_id: "a", captured_at: "2026-08-31T05:00:00.000Z", equity_usd: 3 },
], "account_id");
assert.equal(latestEquities.get("a").equity_usd, 3, "the freshest equity row wins deterministically per follower account");
assert.equal(latestEquities.get("b").equity_usd, 2);

const entry = {
  command_type: "PLACE_ORDER",
  status: "SUCCEEDED",
  execution_order_id: "entry-order-1",
  strategy_signal_key: "signal:entry",
  payload: { action: "ENTRY", direction: "long" },
  created_at: "2026-08-31T05:01:00.000Z",
  updated_at: "2026-08-31T05:01:01.000Z",
};
const preSubmitRepriceFailure = {
  command_type: "MODIFY_ORDER",
  status: "FAILED",
  execution_order_id: "tp-order-existing",
  strategy_signal_key: "signal:tp1:reprice",
  payload: { strategyAction: "TAKE_PROFIT_REPRICE", direction: "long", expectedEntryOrderId: "entry-order-1" },
  last_error_code: "TP_REPRICE_REJECTED",
  last_error_message: "The replacement price was rejected before adapter submission.",
  created_at: "2026-08-31T05:02:00.000Z",
  updated_at: "2026-08-31T05:02:01.000Z",
};
const repriceTelemetry = latestBindingExecutionTelemetry([entry, preSubmitRepriceFailure]);
assert.equal(repriceTelemetry.latestExecutionVenueOrderSubmitted, false, "an existing target order ID does not mislabel a failed MODIFY_ORDER mutation as venue-submitted");
const acknowledgedPlaceFailure = latestBindingExecutionTelemetry([{
  ...entry,
  status: "FAILED",
  last_error_code: "POST_ACK_RECONCILIATION_FAILED",
}]);
assert.equal(acknowledgedPlaceFailure.latestExecutionVenueOrderSubmitted, true, "a failed PLACE_ORDER with its own durable order link still proves venue acknowledgement");

const repositorySource = fs.readFileSync(new URL("../server/strategy-automation/repository.js", import.meta.url), "utf8");
assert.match(repositorySource, /buildInvestmentGroupExecutionPreflight[\s\S]*executionPreflightRequired: true/, "group arm and resume use mandatory follower preflight");
assert.match(repositorySource, /groupExecutionPreflight:[\s\S]*followerPreflightFailures:/, "group snapshots surface persisted follower failures without exposing secrets");
assert.match(repositorySource, /command_type[^\n]*PLACE_ORDER[^\n]*execution_order_id/, "venue-submitted telemetry requires the failed command's own place-order acknowledgement");

console.log("Strategy group preflight tests PASS — every follower is independently checked for fresh funds, leverage, venue rules and complete TP protection; mutation telemetry no longer mistakes an existing order link for submission.");
