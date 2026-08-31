import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildGroupStrategyProtectionRepairCommand,
  buildStrategyProtectionRepairCommand,
  persistStrategyProtectionRepairCommand,
  strategyProtectionLossCandidate,
  strategyProtectionRepairSuppression
} from "../server/cloud-execution/connection-supervisor.js";

const order = {
  id: "tp-order-1",
  user_id: "user-1",
  account_id: "account-1",
  client_order_id: "bt-tp-original",
  symbol: "BTCUSDT",
  side: "sell",
  order_type: "limit",
  quantity: 0.01,
  filled_quantity: 0.002,
  status: "cancelled",
  reduce_only: true,
  origin: "STRATEGY_AUTOMATION_LIVE",
  strategy_automation_id: "strategy-1",
  strategy_target_binding_id: "binding-1",
  group_intent_id: null,
  mandate_id: null
};
const binding = {
  id: "binding-1",
  strategy_id: "strategy-1",
  strategy_version: 6,
  owner_user_id: "user-1",
  target_type: "BROKER_ACCOUNT",
  connection_id: "connection-1",
  account_id: "account-1",
  market_type: "FUTURES"
};
const strategy = { id: "strategy-1", owner_user_id: "user-1", symbol: "BTCUSDT", running_version: 6 };
const connection = { id: "connection-1", account_id: "account-1", execution_environment: "MAINNET_LIVE" };
const sourceCommand = {
  id: "tp-command-1",
  idempotency_key: "tp-key-1",
  command_type: "PLACE_ORDER",
  status: "SUCCEEDED",
  execution_order_id: order.id,
  created_at: "2026-08-31T00:01:00.000Z",
  payload: {
    action: "TAKE_PROFIT",
    direction: "long",
    targetId: "TP1",
    parentEntryIdempotencyKey: "entry-key-1"
  }
};
const buildDirect = (value = order) => buildStrategyProtectionRepairCommand({
  order: value,
  report: { updatedTime: 1_788_131_000_000 },
  binding,
  strategy,
  sourceCommand,
  connection,
  executionEnvironment: "MAINNET_LIVE",
  direction: "long",
  parentEntryIdempotencyKey: "entry-key-1",
  expectedEntryOrderId: "entry-order-1"
});

assert.equal(strategyProtectionLossCandidate(order), true, "a partially filled cancelled strategy limit TP needs repair");
assert.equal(strategyProtectionLossCandidate({ ...order, status: "rejected", filled_quantity: 0 }), true, "a rejected strategy limit TP needs repair");
const cancelledRepair = buildDirect();
const rejectedRepair = buildDirect({ ...order, id: "tp-order-rejected", status: "rejected", filled_quantity: 0 });
assert.equal(cancelledRepair.command_type, "PLACE_ORDER");
assert.equal(cancelledRepair.payload.action, "TAKE_PROFIT", "repair stays on the certified TP fail-safe route");
assert.equal(cancelledRepair.payload.forceProtectionFailSafeFlatten, true);
assert.equal(cancelledRepair.payload.parentEntryIdempotencyKey, "entry-key-1");
assert.equal(cancelledRepair.payload.expectedEntryOrderId, "entry-order-1");
assert.equal(cancelledRepair.payload.direction, "long");
assert.equal(cancelledRepair.priority, 5);
assert.equal(cancelledRepair.max_attempts, 100);
assert.ok(cancelledRepair.deterministic_client_order_id.length <= 36);
assert.ok(rejectedRepair, "rejection uses the same terminal protection-repair contract");

const duplicateRepair = buildDirect({ ...order, id: "tp-order-2", client_order_id: "bt-tp-second" });
assert.equal(duplicateRepair.idempotency_key, cancelledRepair.idempotency_key, "all cancelled TP legs from one entry generation collapse to one safety flatten");
assert.equal(duplicateRepair.strategy_signal_key, cancelledRepair.strategy_signal_key);
assert.equal(duplicateRepair.deterministic_client_order_id, cancelledRepair.deterministic_client_order_id);

const commandStore = fakeCommandStore();
const firstPersist = await persistStrategyProtectionRepairCommand(commandStore.supabase, cancelledRepair);
const duplicatePersist = await persistStrategyProtectionRepairCommand(commandStore.supabase, duplicateRepair);
assert.deepEqual(firstPersist, { inserted: true, id: "repair-command-1" });
assert.deepEqual(duplicatePersist, { inserted: false, id: "repair-command-1" });
assert.equal(commandStore.rows.size, 1, "duplicate private events cannot create duplicate broker work");
assert.deepEqual(commandStore.lastConflictOptions, { onConflict: "idempotency_key", ignoreDuplicates: true });

for (const flatOrUnowned of [
  { ...order, status: "filled", filled_quantity: 0.01 },
  { ...order, status: "cancelled", filled_quantity: 0.01 },
  { ...order, reduce_only: false },
  { ...order, order_type: "market" },
  { ...order, strategy_automation_id: null },
  { ...order, strategy_target_binding_id: null },
  { ...order, status: "accepted" }
]) {
  assert.equal(strategyProtectionLossCandidate(flatOrUnowned), false, "flat, non-TP, non-strategy and nonterminal orders are ignored");
  assert.equal(buildDirect(flatOrUnowned), null);
}

const parent = {
  id: "entry-command-1",
  idempotency_key: "entry-key-1",
  command_type: "PLACE_ORDER",
  status: "SUCCEEDED",
  execution_order_id: "entry-order-1",
  created_at: "2026-08-31T00:00:00.000Z",
  payload: { action: "ENTRY", direction: "long" }
};
assert.equal(strategyProtectionRepairSuppression({
  sourceCommand,
  relatedCommands: [parent, sourceCommand, {
    id: "new-entry",
    command_type: "PLACE_ORDER",
    status: "SUCCEEDED",
    execution_order_id: "entry-order-2",
    created_at: "2026-08-31T00:02:00.000Z",
    payload: { action: "ENTRY", direction: "long" }
  }]
}), "SUPERSEDED_POSITION_GENERATION", "a cancelled TP cannot flatten a newer same-direction generation");
assert.equal(strategyProtectionRepairSuppression({
  sourceCommand,
  relatedCommands: [sourceCommand, {
    id: "replacement-tp",
    command_type: "PLACE_ORDER",
    status: "SUCCEEDED",
    execution_order_id: "replacement-order",
    created_at: "2026-08-31T00:02:00.000Z",
    payload: { action: "TAKE_PROFIT", direction: "long", targetId: "TP1", parentEntryIdempotencyKey: "entry-key-1" }
  }]
}), "SUPERSEDED_TAKE_PROFIT_ORDER");
assert.equal(strategyProtectionRepairSuppression({
  sourceCommand,
  relatedCommands: [sourceCommand, {
    id: "older-tp",
    command_type: "PLACE_ORDER",
    status: "SUCCEEDED",
    execution_order_id: "older-order",
    created_at: "2026-08-31T00:00:30.000Z",
    payload: { action: "TAKE_PROFIT", direction: "long", targetId: "TP1", parentEntryIdempotencyKey: "entry-key-1" }
  }]
}), null, "an older TP attempt is not a replacement for the terminal order being monitored");
assert.equal(strategyProtectionRepairSuppression({
  sourceCommand,
  relatedCommands: [sourceCommand, {
    id: "cancel-replace",
    command_type: "CANCEL_ORDER",
    status: "PROCESSING",
    execution_order_id: order.id,
    payload: { cancellationReason: "TAKE_PROFIT_REPRICE_REPLACE" }
  }]
}), "INTENTIONAL_TAKE_PROFIT_REPLACEMENT");
assert.equal(strategyProtectionRepairSuppression({
  sourceCommand,
  relatedCommands: [sourceCommand, {
    id: "in-place-reprice",
    command_type: "MODIFY_ORDER",
    status: "SUCCEEDED",
    execution_order_id: order.id,
    payload: { strategyAction: "TAKE_PROFIT_REPRICE" }
  }]
}), null, "an in-place amend does not make a later terminal cancellation safe");

const groupIntent = {
  id: "group-tp-intent-1",
  strategy_automation_id: "strategy-1",
  strategy_target_binding_id: "binding-group",
  strategy_direction: "short",
  strategy_execution_policy: { parentGroupIntentId: "group-entry-intent-1", targetId: "TP2" }
};
const groupOrder = {
  ...order,
  id: "group-tp-order-1",
  user_id: "follower-1",
  account_id: "follower-account-1",
  side: "buy",
  filled_quantity: 0,
  origin: "INVESTMENT_GROUP",
  strategy_target_binding_id: "binding-group",
  group_intent_id: groupIntent.id,
  mandate_id: "mandate-1"
};
const groupSource = {
  id: "group-tp-command-1",
  command_type: "PLACE_ORDER",
  user_id: "follower-1",
  connection_id: "follower-connection-1",
  group_intent_id: groupIntent.id,
  follower_plan_id: "follower-plan-1",
  payload: { intentId: groupIntent.id, mandateId: "mandate-1", executionLeg: "primary" }
};
const groupRepair = buildGroupStrategyProtectionRepairCommand({
  order: groupOrder,
  report: { updatedTime: 1_788_131_000_000 },
  binding: { ...binding, id: "binding-group", target_type: "INVESTMENT_GROUP", group_id: "group-1" },
  groupIntent,
  sourceCommand: groupSource,
  plan: { id: "follower-plan-1", mandate_id: "mandate-1" },
  connection: { id: "follower-connection-1" },
  executionEnvironment: "MAINNET_LIVE",
  direction: "short",
  parentGroupIntentId: "group-entry-intent-1",
  expectedEntryOrderId: "group-entry-order-1"
});
assert.equal(groupRepair.payload.forceProtectionFailSafeFlatten, true);
assert.equal(groupRepair.payload.expectedEntryOrderId, "group-entry-order-1");
assert.equal(groupRepair.group_intent_id, groupIntent.id);
assert.equal(groupRepair.follower_plan_id, "follower-plan-1");
assert.equal(groupRepair.user_id, "follower-1");
const groupRepairWithoutExpectedSnapshot = buildGroupStrategyProtectionRepairCommand({
  order: groupOrder,
  binding: { id: "binding-group" },
  groupIntent,
  sourceCommand: groupSource,
  plan: { id: "follower-plan-1", mandate_id: "mandate-1" },
  connection: { id: "follower-connection-1" },
  executionEnvironment: "MAINNET_LIVE",
  direction: "short",
  parentGroupIntentId: "group-entry-intent-1",
  expectedEntryOrderId: null
});
assert.ok(groupRepairWithoutExpectedSnapshot, "the signed parent intent still lets the worker resolve the immutable entry when the supervisor snapshot link is temporarily absent");
assert.equal(groupRepairWithoutExpectedSnapshot.payload.expectedEntryOrderId, null);

const supervisorSource = fs.readFileSync(new URL("../server/cloud-execution/connection-supervisor.js", import.meta.url), "utf8");
const orderEventSource = supervisorSource.slice(supervisorSource.indexOf("async applyOrderEvent"), supervisorSource.indexOf("async monitorStrategyTakeProfitProtection"));
assert.ok(orderEventSource.indexOf("applyExecutionOrderState(") < orderEventSource.indexOf("monitorStrategyTakeProfitProtection("), "terminal monitoring runs only after the atomic venue-order transition");
assert.match(supervisorSource, /forceProtectionFailSafeFlatten:\s*true/);
assert.doesNotMatch(supervisorSource, /\.placeOrder\s*\(/, "the private-stream supervisor only enqueues durable repair work and never calls the broker");

console.log("Strategy protection monitor tests passed: terminal TP repair, generation guards, idempotency, group routing and flat/non-strategy no-op.");

function fakeCommandStore() {
  const rows = new Map();
  const state = { sequence: 0, lastConflictOptions: null };
  class Query {
    constructor() {
      this.operation = "select";
      this.value = null;
      this.filters = [];
      this.inserted = null;
    }

    upsert(value, options) {
      this.operation = "upsert";
      this.value = structuredClone(value);
      state.lastConflictOptions = options;
      return this;
    }

    select() { return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }

    async maybeSingle() {
      if (this.operation === "upsert") {
        const existing = rows.get(this.value.idempotency_key);
        if (existing) return { data: null, error: null };
        const row = { ...this.value, id: `repair-command-${++state.sequence}` };
        rows.set(row.idempotency_key, row);
        return { data: { id: row.id }, error: null };
      }
      const row = [...rows.values()].find((candidate) => this.filters.every(([field, value]) => candidate[field] === value));
      return { data: row ? { id: row.id } : null, error: null };
    }
  }
  return {
    rows,
    get lastConflictOptions() { return state.lastConflictOptions; },
    supabase: {
      from(table) {
        assert.equal(table, "execution_commands");
        return new Query();
      }
    }
  };
}
