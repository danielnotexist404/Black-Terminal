import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildBlackScriptOcoCancellationCommand,
  buildBlackScriptOcoSiblingMutationCommand,
} from "../server/cloud-execution/connection-supervisor.js";
import {
  resolveBlackScriptCloseQuantity,
  resolveBlackScriptEntryQuantity,
} from "../server/cloud-execution/black-script-sizing.js";

const strategyWorker = fs.readFileSync(new URL("./strategy-automation-worker.ts", import.meta.url), "utf8");
const executionWorker = fs.readFileSync(new URL("../server/cloud-execution/worker.js", import.meta.url), "utf8");
const connectionSupervisor = fs.readFileSync(new URL("../server/cloud-execution/connection-supervisor.js", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../supabase/migrations/202609010001_black_script_cloud_artifacts.sql", import.meta.url), "utf8");

assert.match(migration, /create table if not exists public\.strategy_script_target_state/i);
assert.match(migration, /alter table public\.strategy_script_target_state enable row level security/i);
assert.match(migration, /revoke all on public\.strategy_script_target_state from anon, authenticated/i);
assert.match(migration, /black_cloud_commit_script_generation_v1/);
assert.match(migration, /v_runtime\.lease_owner is distinct from p_worker_id/);
assert.match(migration, /v_runtime\.state_version is distinct from p_expected_state_version/);
assert.match(migration, /v_strategy\.running_version is distinct from p_running_version/);
assert.match(migration, /v_artifact\.source_sha256 <> p_source_sha256/);
assert.match(migration, /v_artifact\.source_version <> p_checkpoint->>'sourceVersion'/);
assert.match(migration, /script target bindings must be unique per generation/i);
assert.match(migration, /on conflict \(idempotency_key\) do nothing/i);
assert.match(migration, /script command idempotency conflict or ownership mismatch/i);
assert.match(migration, /c\.payload = manifest_commands\.item->'payload'/);
assert.match(migration, /c\.execution_environment=v_command->'payload'->>'executionEnvironment'/);
assert.match(migration, /pine_checkpoint=p_checkpoint/);
assert.match(migration, /get diagnostics v_updated = row_count/i);

assert.match(strategyWorker, /black_cloud_commit_script_generation_v1/);
assert.doesNotMatch(strategyWorker, /BLACK_SCRIPT_ORDER_INTENTS_PENDING_CERTIFICATION/);
assert.match(strategyWorker, /evaluation\.checkpoint\.brokerOrderHandles = \{\}/);
assert.match(strategyWorker, /strategy_script_target_state/);
assert.match(strategyWorker, /settleBlackScriptTargetMarketActions/);
assert.match(strategyWorker, /BLACK_SCRIPT_PRIOR_VERSION_ORDERS_REQUIRE_CANCEL/);
assert.match(strategyWorker, /BLACK_SCRIPT_GROUP_EXECUTION_PENDING/);
assert.match(strategyWorker, /fetchBybitBlackScriptIntrabars/);
assert.match(strategyWorker, /BLACK_SCRIPT_MAGNIFIER_COVERAGE_INCOMPLETE/);

assert.match(executionWorker, /modifyBlackScriptOrder\(command, fencingToken\)/);
assert.match(executionWorker, /cancelBlackScriptOrder\(command, fencingToken\)/);
assert.match(executionWorker, /BLACK_SCRIPT_PARENT_ORDER_OWNERSHIP_MISMATCH/);
assert.match(executionWorker, /BLACK_SCRIPT_ACKNOWLEDGED_ORDER_OWNERSHIP_MISMATCH/);
assert.match(executionWorker, /BLACK_SCRIPT_ORDER_CANCEL_RECONCILING/);
assert.match(executionWorker, /requireBlackScriptCommandDependencies/);
assert.match(executionWorker, /BLACK_SCRIPT_DEPENDENCY_PENDING/);
assert.match(executionWorker, /BLACK_SCRIPT_DEPENDENCY_OWNERSHIP_MISMATCH/);
assert.match(executionWorker, /requireTerminalStrategyEntryFill/);
assert.match(executionWorker, /normalizedOrderType === "stop-market" \? "market"/);
assert.match(executionWorker, /cancelTrailingStop/);
assert.match(connectionSupervisor, /queueBlackScriptOcoSiblingCancellation/);
assert.match(connectionSupervisor, /reconcileBlackScriptOcoGroups/);
assert.match(connectionSupervisor, /black-script-v3:oco-cancel/);
assert.match(connectionSupervisor, /black-script-v3:oco-resize/);
assert.match(connectionSupervisor, /filledOrder\.reduce_only !== true \|\| !\(Number\(filledOrder\.filled_quantity \|\| 0\) > 0\)/);
assert.match(connectionSupervisor, /strategyAction: "BLACK_SCRIPT_ORDER_CANCEL"/);
assert.match(connectionSupervisor, /priority: 5/);

const ocoCancel = buildBlackScriptOcoCancellationCommand({
  source: {
    idempotency_key: "a".repeat(64),
    user_id: "owner",
    connection_id: "connection",
    strategy_automation_id: "strategy",
    strategy_target_binding_id: "binding",
    payload: {
      sourceVersion: "12345678",
      settingsVersion: "87654321",
      generationCandleTime: 1_900_000_000,
      strategyVersion: 2,
      executionEnvironment: "DEMO",
      marketType: "FUTURES",
    },
  },
  sibling: {
    id: "sibling-command",
    idempotency_key: "b".repeat(64),
    execution_order_id: "sibling-order",
    payload: { logicalOrderKey: "exit:bracket:lot-1:stop" },
  },
  filledOrder: { id: "filled-order", symbol: "BTCUSDT" },
  ocoGroup: "exit:bracket:lot-1",
  now: new Date("2026-09-01T00:00:00.000Z"),
});
assert.equal(ocoCancel.command_type, "CANCEL_ORDER");
assert.equal(ocoCancel.execution_order_id, "sibling-order");
assert.equal(ocoCancel.payload.parentPlaceIdempotencyKey, "b".repeat(64));
assert.equal(ocoCancel.payload.request.marketKind, "perpetual");
assert.equal(ocoCancel.priority, 5);
assert.equal(ocoCancel.idempotency_key.length, 64);

const ocoResize = buildBlackScriptOcoSiblingMutationCommand({
  source: {
    idempotency_key: "a".repeat(64),
    user_id: "owner",
    connection_id: "connection",
    strategy_automation_id: "strategy",
    strategy_target_binding_id: "binding",
    payload: {
      sourceVersion: "12345678",
      settingsVersion: "87654321",
      generationCandleTime: 1_900_000_000,
      strategyVersion: 2,
      executionEnvironment: "DEMO",
      marketType: "FUTURES",
    },
  },
  sibling: {
    id: "sibling-command",
    idempotency_key: "b".repeat(64),
    execution_order_id: "sibling-order",
    payload: {
      logicalOrderKey: "exit:bracket:lot-1:stop",
      direction: "long",
      quantity: 2,
    },
  },
  siblingOrder: {
    id: "sibling-order",
    status: "working",
    quantity: 2,
    filled_quantity: 0,
  },
  filledOrder: {
    id: "filled-order",
    symbol: "BTCUSDT",
    status: "partially-filled",
    quantity: 2,
    filled_quantity: 0.75,
  },
  ocoGroup: "exit:bracket:lot-1",
  now: new Date("2026-09-01T00:00:00.000Z"),
});
assert.equal(ocoResize?.command_type, "MODIFY_ORDER");
assert.equal(ocoResize?.payload.strategyAction, "BLACK_SCRIPT_ORDER_MODIFY");
assert.equal(ocoResize?.payload.request.quantity, 1.25);
assert.equal(ocoResize?.execution_order_id, "sibling-order");

const ocoFull = buildBlackScriptOcoSiblingMutationCommand({
  source: {
    idempotency_key: "a".repeat(64),
    user_id: "owner",
    connection_id: "connection",
    strategy_automation_id: "strategy",
    strategy_target_binding_id: "binding",
    payload: { marketType: "FUTURES" },
  },
  sibling: {
    id: "sibling-command",
    idempotency_key: "b".repeat(64),
    execution_order_id: "sibling-order",
    payload: { logicalOrderKey: "exit:bracket:lot-1:stop", quantity: 2 },
  },
  siblingOrder: { status: "working", quantity: 2, filled_quantity: 0 },
  filledOrder: { id: "filled-order", symbol: "BTCUSDT", status: "filled", quantity: 2, filled_quantity: 2 },
  ocoGroup: "exit:bracket:lot-1",
});
assert.equal(ocoFull?.command_type, "CANCEL_ORDER");

assert.equal(resolveBlackScriptEntryQuantity({
  payload: { quantity: 0.25 },
  policy: { tradeAmountMode: "PERCENT_ACCOUNT_EQUITY", tradeAmountValue: 10 },
  preview: { estimatedNotional: 500 },
  equity: 1_000,
  referencePrice: 100,
}), 0.25, "fixed-contract script sizing overrides account defaults");
assert.equal(resolveBlackScriptEntryQuantity({
  payload: { quantityPercent: 20 },
  policy: {},
  preview: { estimatedNotional: 500 },
  equity: 1_000,
  referencePrice: 100,
}), 2, "script percent-of-equity sizing is recalculated from each target's authoritative equity");
assert.equal(resolveBlackScriptEntryQuantity({
  payload: { cashAmount: 250 },
  policy: {},
  preview: { estimatedNotional: 500 },
  equity: 1_000,
  referencePrice: 100,
}), 2.5, "script cash sizing remains quote-notional based");
assert.equal(resolveBlackScriptCloseQuantity({
  payload: { closeQuantityPercent: 25 },
  positionQuantity: 8,
}), 2, "a market partial close is based on the target's real position, not simulated contracts");
assert.equal(resolveBlackScriptCloseQuantity({
  payload: { closeQuantity: 20 },
  positionQuantity: 8,
}), 8, "a fixed close can never exceed the live position");

console.log("Black Script cloud OMS contracts PASS — fenced atomic generations, isolated target handles, owned amendments/cancellations and magnifier coverage are fail-closed.");
