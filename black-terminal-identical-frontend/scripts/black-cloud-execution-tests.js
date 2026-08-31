import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  canonicalize,
  createDeterministicClientOrderId,
  createExecutionIdempotencyKey,
  hashCanonicalPayload,
  signCanonicalPayload,
  verifyCanonicalSignature
} from "../server/cloud-execution/canonical.js";
import { calculateFollowerAllocation, evaluateFollowerRisk, floorToStep } from "../server/cloud-execution/allocation-risk.js";
import { BlackCloudRepository, redactObject, sanitizeError } from "../server/cloud-execution/repository.js";
import { createCloudExchangeAdapter, listCloudExchangeAdapters } from "../server/cloud-execution/adapters/registry.js";
import {
  BlackCloudExecutionWorker,
  assertAcknowledgedOrderOwnership,
  followerPlanStatusForExecutionFailure,
  hasPositiveFollowerPlanFill,
  isAggregatedTargetSuppressed,
  isAmbiguousTransportError,
  isCurrentStrategyEntryGeneration,
  isTerminalFollowerPlanRejection,
  isTerminalTakeProfitProtectionFailure,
  mandateListAllows,
  strategyCommandAuditMetadata,
  strategyDependencyCancellation,
  strategyDependencyCancellationMessage
} from "../server/cloud-execution/worker.js";
import {
  buildBybitOrderRequestBody,
  evaluateBybitOrderDraftAgainstMetadata,
  isBybitDerivativesCloseAllOrder,
  normalizeBybitError
} from "../server/exchanges/bybit.js";

process.env.BLACK_CLOUD_INTENT_SIGNING_KEY = "black-terminal-test-signing-key-32-bytes-minimum";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

test("canonical serialization is key-order independent", () => {
  assert.equal(canonicalize({ b: 2, a: { d: 4, c: 3 } }), canonicalize({ a: { c: 3, d: 4 }, b: 2 }));
});

test("server exchange adapter registry exposes the complete Bybit contract", () => {
  const adapter = createCloudExchangeAdapter("bybit", { credentials: { apiKey: "test", apiSecret: "test", executionEnvironment: "DEMO" }, executionEnvironment: "DEMO" });
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

test("automation mandate lists honor empty allow-all, wildcard, exact, and case-normalized values", () => {
  assert.equal(mandateListAllows([], "XRPUSDT"), true);
  assert.equal(mandateListAllows(["*"], "XRPUSDT"), true);
  assert.equal(mandateListAllows(["btcusdt"], "BTCUSDT"), true);
  assert.equal(mandateListAllows(["BTCUSDT"], "XRPUSDT"), false);
});

test("strategy slippage ticks use Bybit's integer TickSize contract", () => {
  const body = buildBybitOrderRequestBody({
    marketKind: "perpetual",
    symbol: "XRPUSDT",
    side: "buy",
    orderType: "market",
    quantity: 80,
    timeInForce: "ioc",
    positionIdx: 0,
    clientOrderId: "bt-test-slippage",
    slippageToleranceTicks: 2,
  }, { normalized: { quantity: 80 }, metadata: { quantityPrecision: 1 } });
  assert.equal(body.slippageToleranceType, "TickSize");
  assert.equal(body.slippageTolerance, "2");
});

test("Bybit derivatives close-all is narrowly limited to zero-quantity reduce-only market orders", () => {
  const closeAll = {
    marketKind: "perpetual",
    symbol: "BTCUSDT",
    side: "sell",
    orderType: "market",
    quantity: 0,
    referencePrice: 64_000,
    reduceOnly: true,
    closeOnTrigger: true,
    positionIdx: 0,
    timeInForce: "ioc",
    clientOrderId: "bt-fail-safe-f"
  };
  const metadata = {
    tradingStatus: "Trading",
    minQuantity: 0.001,
    maxQuantity: 100,
    maxMarketQuantity: 10,
    quantityStep: 0.001,
    minNotional: 5,
    quantityPrecision: 3,
    supportedMarginModes: ["cross"]
  };
  const validation = evaluateBybitOrderDraftAgainstMetadata(metadata, closeAll, { category: "linear", symbol: "BTCUSDT" });
  assert.equal(validation.ok, true);
  assert.equal(isBybitDerivativesCloseAllOrder(closeAll), true);
  assert.deepEqual(
    pick(buildBybitOrderRequestBody(closeAll, validation), ["category", "orderType", "qty", "reduceOnly", "closeOnTrigger", "positionIdx"]),
    { category: "linear", orderType: "Market", qty: "0", reduceOnly: true, closeOnTrigger: true, positionIdx: 0 }
  );
  for (const unsafe of [
    { ...closeAll, marketKind: "spot" },
    { ...closeAll, reduceOnly: false },
    { ...closeAll, orderType: "limit", limitPrice: 64_000 },
    { ...closeAll, quantity: 1 }
  ]) {
    const result = evaluateBybitOrderDraftAgainstMetadata(metadata, unsafe, { category: unsafe.marketKind === "spot" ? "spot" : "linear", symbol: "BTCUSDT" });
    assert.equal(result.ok, false);
    assert.equal(isBybitDerivativesCloseAllOrder(unsafe), false);
  }
});

test("slippage errors are not misclassified as IP restrictions", () => {
  assert.equal(normalizeBybitError(10001, "max slippage invalid", 400).code, "BROKER_UNAVAILABLE");
  assert.equal(normalizeBybitError(10010, "Unmatched IP", 403).code, "IP_RESTRICTION");
});

test("composite SQL null leases cannot become fencing token zero", async () => {
  const calls = [];
  const supabase = {
    rpc: async (name, parameters) => {
      calls.push({ name, parameters });
      if (name === "black_cloud_acquire_worker_lease") return {
        data: { lease_key: null, worker_id: null, fencing_token: null },
        error: null,
      };
      return { data: [], error: null };
    },
  };
  const repository = new BlackCloudRepository(supabase, "worker-1", "DEMO", false);
  assert.equal(await repository.acquireLease("connection-1", 30), null);
  await repository.claimCommands();
  assert.equal(calls.at(-1).parameters.p_lock_seconds, 300);
});

test("Bybit server timing-out responses enter deterministic reconciliation", () => {
  assert.equal(isAmbiguousTransportError(new Error("The upstream server is timing out")), true);
});

test("expired processing work is recovered through deterministic reconciliation", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202608300007_black_cloud_processing_recovery.sql", import.meta.url), "utf8");
  assert.match(sql, /c\.status='PROCESSING'/);
  assert.match(sql, /then 'SUBMISSION_UNKNOWN' else 'RETRY'/);
  assert.match(sql, /a\.fencing_token=l\.fencing_token/);
  assert.match(sql, /p_lock_seconds integer default 300/);
});

test("worker startup is gated on the atomic order-state release boundary", () => {
  const repositorySource = fs.readFileSync(new URL("../server/cloud-execution/repository.js", import.meta.url), "utf8");
  const workerSource = fs.readFileSync(new URL("../server/cloud-execution/worker.js", import.meta.url), "utf8");
  assert.match(repositorySource, /execution_orders[\s\S]*venue_cumulative_updated_at[\s\S]*reconciliation_policy_version[\s\S]*atomicOrderState[\s\S]*reconciliationLiveness/);
  assert.match(workerSource, /strategyRuntime", "atomicOrderState", "reconciliationLiveness"/);
});

test("strategy generations are atomic, idempotent and claimable only after the complete manifest is durable", async () => {
  const reconciliationMigration = fs.readFileSync(new URL("../supabase/migrations/202608310002_black_cloud_reconciliation_liveness.sql", import.meta.url), "utf8");
  const generationMigration = fs.readFileSync(new URL("../supabase/migrations/202608310003_strategy_generation_release_barrier.sql", import.meta.url), "utf8");
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql stable
      as $$ select coalesce(current_setting('request.jwt.claim.role', true), '') $$;
    create table public.connectivity_connections(
      id uuid primary key,
      execution_environment text not null
    );
    create table public.group_trade_intents(
      id uuid primary key,
      group_id uuid,
      strategy_automation_id uuid,
      strategy_target_binding_id uuid,
      strategy_action text,
      strategy_execution_policy jsonb not null default '{}'::jsonb
    );
    create table public.strategy_target_bindings(
      id uuid primary key,
      strategy_id uuid not null,
      owner_user_id uuid not null,
      target_type text not null,
      connection_id uuid,
      group_id uuid
    );
    create table public.execution_commands(
      id uuid primary key default gen_random_uuid(),
      command_type text not null,
      user_id uuid,
      connection_id uuid,
      group_intent_id uuid,
      follower_plan_id uuid,
      execution_order_id uuid,
      idempotency_key text not null unique,
      deterministic_client_order_id text,
      payload jsonb not null default '{}'::jsonb,
      status text not null default 'QUEUED',
      priority integer not null default 100,
      attempt_count integer not null default 0,
      max_attempts integer not null default 8,
      available_at timestamptz not null default now(),
      locked_by text,
      locked_until timestamptz,
      fencing_token bigint,
      last_error_code text,
      last_error_message text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz,
      strategy_automation_id uuid,
      strategy_target_binding_id uuid,
      strategy_signal_key text,
      execution_environment text
    );
    create table public.execution_command_attempts(
      id bigint generated always as identity primary key,
      command_id uuid not null,
      worker_id text,
      fencing_token bigint,
      attempt_number integer,
      outcome text,
      error_code text,
      error_message text,
      safe_details jsonb default '{}'::jsonb,
      completed_at timestamptz
    );
    create table public.worker_leases(
      lease_key text primary key,
      worker_id text,
      fencing_token bigint,
      expires_at timestamptz
    );
    create function public.test_set_command_environment() returns trigger language plpgsql as $$
    begin
      if new.connection_id is not null then
        select execution_environment into new.execution_environment
        from public.connectivity_connections where id=new.connection_id;
      end if;
      return new;
    end $$;
    create trigger trg_test_command_environment before insert or update of connection_id
      on public.execution_commands for each row execute function public.test_set_command_environment();
  `);
  await db.exec(reconciliationMigration);
  await db.exec(generationMigration);
  await db.exec("set request.jwt.claim.role='service_role'");

  const strategyId = "11111111-1111-4111-8111-111111111111";
  const bindingId = "22222222-2222-4222-8222-222222222222";
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const connectionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const groupBindingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const groupId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const stagedUntil = "9999-12-31T23:59:59.999Z";
  await db.query("insert into public.connectivity_connections values($1,'MAINNET_LIVE')", [connectionId]);
  await db.query("insert into public.strategy_target_bindings values($1,$2,$3,'BROKER_ACCOUNT',$4,null)", [bindingId, strategyId, userId, connectionId]);
  await db.query("insert into public.strategy_target_bindings values($1,$2,$3,'INVESTMENT_GROUP',null,$4)", [groupBindingId, strategyId, userId, groupId]);
  const claim = (worker, claimGlobal = false) => db.query(
    "select idempotency_key,status,attempt_count from public.black_cloud_claim_execution_commands($1,100,60,'MAINNET_LIVE',$2)",
    [worker, claimGlobal],
  );
  const directCommand = ({ key, action, targetId = null, parentKey = null, takeProfits = [], priority = 50 }) => ({
    commandType: "PLACE_ORDER",
    userId,
    connectionId,
    groupIntentId: null,
    strategySignalKey: `signal:${key}:strategy-generation`,
    idempotencyKey: key,
    deterministicClientOrderId: `bt-${key}`,
    payload: action === "TAKE_PROFIT"
      ? { action, targetId, parentEntryIdempotencyKey: parentKey }
      : { action, takeProfits },
    priority,
    maxAttempts: 100,
  });
  const enqueue = (parent, children = [], targetBindingId = bindingId) => db.query(
    "select public.black_cloud_enqueue_strategy_generation_v1($1,$2,$3::jsonb,$4::jsonb) as enqueued",
    [strategyId, targetBindingId, JSON.stringify(parent), JSON.stringify(children)],
  );

  // Backward-repair path: an old worker may have staged a parent and then
  // crashed after TP3. The production claim RPC from migration 002 must not
  // return any of those future-dated rows before a complete release.
  const legacyParentKey = "legacy-direct-parent";
  const legacyChildKeys = Array.from({ length: 7 }, (_, index) => `legacy-direct-tp-${index + 1}`);
  const directTargets = legacyChildKeys.map((_, index) => ({ id: `TP${index + 1}` }));
  await db.query(
    `insert into public.execution_commands(id,idempotency_key,strategy_automation_id,strategy_target_binding_id,
      command_type,user_id,connection_id,strategy_signal_key,deterministic_client_order_id,payload,available_at,max_attempts)
      values($1,$2,$3,$4,'PLACE_ORDER',$5,$6,$7,$8,$9,$10,100)`,
    ["30000000-0000-4000-8000-000000000000", legacyParentKey, strategyId, bindingId, userId, connectionId, "legacy-parent-signal", "bt-legacy-parent", JSON.stringify({ action: "ENTRY", takeProfits: directTargets }), stagedUntil],
  );
  assert.equal((await claim("legacy-parent-check")).rows.length, 0, "the production claim RPC cannot claim a staged parent");
  for (let index = 0; index < 3; index += 1) {
    await db.query(
      `insert into public.execution_commands(id,idempotency_key,strategy_automation_id,strategy_target_binding_id,
        command_type,user_id,connection_id,strategy_signal_key,deterministic_client_order_id,payload,available_at,max_attempts)
        values($1,$2,$3,$4,'PLACE_ORDER',$5,$6,$7,$8,$9,$10,100)`,
      [`30000000-0000-4000-8000-00000000000${index + 1}`, legacyChildKeys[index], strategyId, bindingId, userId, connectionId, `legacy-tp-${index + 1}-signal`, `bt-legacy-tp-${index + 1}`, JSON.stringify({ action: "TAKE_PROFIT", targetId: `TP${index + 1}`, parentEntryIdempotencyKey: legacyParentKey }), stagedUntil],
    );
  }
  await assert.rejects(
    () => db.query("select public.black_cloud_release_strategy_generation_v1($1,$2,$3,$4::text[])", [strategyId, bindingId, legacyParentKey, legacyChildKeys]),
    /manifest is incomplete/i,
  );
  assert.equal((await claim("legacy-tp3-check")).rows.length, 0, "the production claim RPC cannot claim a parent plus TP1-TP3 before release");
  for (let index = 3; index < legacyChildKeys.length; index += 1) {
    await db.query(
      `insert into public.execution_commands(id,idempotency_key,strategy_automation_id,strategy_target_binding_id,
        command_type,user_id,connection_id,strategy_signal_key,deterministic_client_order_id,payload,available_at,max_attempts)
        values($1,$2,$3,$4,'PLACE_ORDER',$5,$6,$7,$8,$9,$10,100)`,
      [`30000000-0000-4000-8000-00000000000${index + 1}`, legacyChildKeys[index], strategyId, bindingId, userId, connectionId, `legacy-tp-${index + 1}-signal`, `bt-legacy-tp-${index + 1}`, JSON.stringify({ action: "TAKE_PROFIT", targetId: `TP${index + 1}`, parentEntryIdempotencyKey: legacyParentKey }), stagedUntil],
    );
  }
  const directRelease = await db.query("select public.black_cloud_release_strategy_generation_v1($1,$2,$3,$4::text[]) as released", [strategyId, bindingId, legacyParentKey, legacyChildKeys]);
  assert.equal(directRelease.rows[0].released, 8);
  const legacyClaim = await claim("legacy-complete-claim");
  assert.equal(legacyClaim.rows.length, 8, "the production claim RPC sees the parent and all seven TPs only after release");

  // New worker path: a malformed partial manifest aborts without inserting a
  // parent, while one complete RPC call inserts all eight rows atomically.
  const atomicParentKey = "atomic-direct-parent";
  const atomicTargets = Array.from({ length: 7 }, (_, index) => ({ id: `TP${index + 1}` }));
  const atomicParent = directCommand({ key: atomicParentKey, action: "ENTRY", takeProfits: atomicTargets });
  const atomicChildren = atomicTargets.map((target, index) => directCommand({
    key: `atomic-direct-tp-${index + 1}`,
    action: "TAKE_PROFIT",
    targetId: target.id,
    parentKey: atomicParentKey,
    priority: 70 + index,
  }));
  await assert.rejects(() => enqueue(atomicParent, atomicChildren.slice(0, 3)), /manifest count/i);
  assert.equal((await db.query("select count(*)::int as count from public.execution_commands where idempotency_key=$1", [atomicParentKey])).rows[0].count, 0, "a rejected TP3 manifest rolls back its parent insert");
  const atomicResult = await enqueue(atomicParent, atomicChildren);
  assert.equal(atomicResult.rows[0].enqueued, 8);
  assert.equal((await claim("atomic-complete-claim")).rows.filter((row) => row.idempotency_key.startsWith("atomic-")).length, 8);
  await db.query(
    "update public.execution_commands set payload=payload||$2::jsonb where idempotency_key=$1",
    [atomicParentKey, JSON.stringify({ takeProfitProtectionDecision: { mode: "FULL_LADDER" } })],
  );
  const idempotentResult = await enqueue(atomicParent, atomicChildren);
  assert.equal(idempotentResult.rows[0].enqueued, 8, "worker-appended protection metadata does not break generation idempotency after a checkpoint crash");
  assert.equal((await db.query("select count(*)::int as count from public.execution_commands where idempotency_key=$1 or idempotency_key like 'atomic-direct-tp-%'", [atomicParentKey])).rows[0].count, 8, "an RPC retry never duplicates the generation");
  await assert.rejects(
    () => enqueue({ ...atomicParent, connectionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", idempotencyKey: "wrong-authority-parent" }, atomicChildren.map((child, index) => ({ ...child, connectionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", idempotencyKey: `wrong-authority-tp-${index + 1}`, payload: { ...child.payload, parentEntryIdempotencyKey: "wrong-authority-parent" } }))),
    /authority does not match its binding/i,
  );

  const closeParent = directCommand({ key: "atomic-close-parent", action: "CLOSE", takeProfits: [], priority: 20 });
  assert.equal((await enqueue(closeParent, [])).rows[0].enqueued, 1, "a zero-child CLOSE uses the same atomic durability boundary");
  const closeClaim = await claim("atomic-close-claim");
  assert.deepEqual(closeClaim.rows.map((row) => row.idempotency_key), ["atomic-close-parent"], "a zero-child parent is immediately claimable");

  const groupParentIntentId = "40000000-0000-4000-8000-000000000000";
  const groupTargetIntentIds = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"];
  const groupParentKey = "group-parent";
  const groupChildren = ["group-tp-1", "group-tp-2"];
  await db.query("insert into public.group_trade_intents values($1,$2,$3,$4,'SYNC_DIRECTION',$5)", [groupParentIntentId, groupId, strategyId, groupBindingId, JSON.stringify({ takeProfits: [{ id: "TP1" }, { id: "TP2" }] })]);
  const groupParent = {
    commandType: "EXPAND_GROUP_INTENT", userId: null, connectionId: null,
    groupIntentId: groupParentIntentId, strategySignalKey: "group-parent-strategy-signal",
    idempotencyKey: groupParentKey, deterministicClientOrderId: null,
    payload: { groupIntentId: groupParentIntentId }, priority: 20, maxAttempts: 100,
  };
  const groupChildCommands = [];
  for (let index = 0; index < groupChildren.length; index += 1) {
    await db.query("insert into public.group_trade_intents values($1,$2,$3,$4,'TAKE_PROFIT',$5)", [groupTargetIntentIds[index], groupId, strategyId, groupBindingId, JSON.stringify({ parentGroupIntentId: groupParentIntentId })]);
    groupChildCommands.push({
      commandType: "EXPAND_GROUP_INTENT", userId: null, connectionId: null,
      groupIntentId: groupTargetIntentIds[index], strategySignalKey: `group-tp-${index + 1}-strategy-signal`,
      idempotencyKey: groupChildren[index], deterministicClientOrderId: null,
      payload: { groupIntentId: groupTargetIntentIds[index] }, priority: 40 + index, maxAttempts: 100,
    });
  }
  assert.equal((await enqueue(groupParent, groupChildCommands, groupBindingId)).rows[0].enqueued, 3);
  const groupClaim = await claim("atomic-group-claim", true);
  assert.equal(groupClaim.rows.filter((row) => [groupParentKey, ...groupChildren].includes(row.idempotency_key)).length, 3);
  await assert.rejects(
    () => enqueue({ ...groupParent, idempotencyKey: "missing-group-parent", groupIntentId: "99999999-9999-4999-8999-999999999999" }, groupChildCommands, groupBindingId),
    /parent intent is missing/i,
  );

  await db.exec("set request.jwt.claim.role='anon'");
  await assert.rejects(
    () => enqueue(closeParent, []),
    /service identity required/i,
  );
  await db.close();
});

test("execution-order and follower-plan transitions are atomic and monotonic in PostgreSQL", async () => {
  const migration = fs.readFileSync(new URL("../supabase/migrations/202608310001_atomic_execution_order_transitions.sql", import.meta.url), "utf8");
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql stable
      as $$ select coalesce(current_setting('request.jwt.claim.role', true), '') $$;
    create table public.connectivity_connections(id uuid primary key, account_id uuid not null);
    create table public.execution_orders(
      id uuid primary key,
      user_id uuid not null,
      account_id uuid not null,
      quantity numeric(24,8) not null,
      status varchar(20) not null,
      filled_quantity numeric(24,8) not null default 0,
      exchange_order_id text,
      average_fill_price numeric(24,8),
      actual_fees numeric not null default 0,
      rejection_reason text,
      venue_updated_at bigint not null default 0,
      updated_at timestamptz not null default now()
    );
    create table public.follower_execution_plans(
      id uuid primary key,
      follower_user_id uuid not null,
      broker_connection_id uuid not null references public.connectivity_connections(id),
      execution_order_id uuid references public.execution_orders(id),
      execution_status text not null default 'PENDING',
      updated_at timestamptz not null default now()
    );
  `);
  await db.exec(migration);
  await db.exec("set request.jwt.claim.role='service_role'");

  const userId = "11111111-1111-4111-8111-111111111111";
  const accountId = "22222222-2222-4222-8222-222222222222";
  const wrongAccountId = "33333333-3333-4333-8333-333333333333";
  const connectionId = "44444444-4444-4444-8444-444444444444";
  const orderId = "55555555-5555-4555-8555-555555555555";
  const planId = "66666666-6666-4666-8666-666666666666";
  await db.query("insert into public.connectivity_connections(id,account_id) values($1,$2)", [connectionId, accountId]);
  await db.query("insert into public.execution_orders(id,user_id,account_id,quantity,status) values($1,$2,$3,1,'accepted')", [orderId, userId, accountId]);
  await db.query("insert into public.follower_execution_plans(id,follower_user_id,broker_connection_id) values($1,$2,$3)", [planId, userId, connectionId]);

  const transition = (argumentsByName) => {
    const entries = Object.entries(argumentsByName);
    return db.query(
      `select public.black_cloud_apply_execution_order_state_v1(${entries.map(([name], index) => `${name} => $${index + 1}`).join(",")}) as result`,
      entries.map(([, value]) => value),
    );
  };
  const state = async () => (await db.query("select status,filled_quantity::float8 as filled_quantity,average_fill_price::float8 as average_fill_price,actual_fees::float8 as actual_fees,venue_updated_at from public.execution_orders where id=$1", [orderId])).rows[0];
  const planStatus = async () => (await db.query("select execution_status from public.follower_execution_plans where id=$1", [planId])).rows[0].execution_status;

  await transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "accepted", p_cumulative_filled_quantity: 0, p_follower_plan_id: planId });
  assert.equal(await planStatus(), "WORKING");
  await transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "partially-filled", p_cumulative_filled_quantity: 0.4, p_average_fill_price: 100, p_venue_updated_at: 200 });
  assert.deepEqual(await state(), { status: "partially-filled", filled_quantity: 0.4, average_fill_price: 100, actual_fees: 0, venue_updated_at: 200 });
  assert.equal(await planStatus(), "PARTIALLY_FILLED");
  await transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "partially-filled", p_fill_delta: 0.4, p_average_fill_price: 99, p_actual_fee_delta: 0.002, p_venue_updated_at: 200 });
  assert.deepEqual(await state(), { status: "partially-filled", filled_quantity: 0.4, average_fill_price: 100, actual_fees: 0.002, venue_updated_at: 200 }, "an execution event already represented by a cumulative order report records fees without double-counting quantity or replacing the venue average");

  await transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "accepted", p_cumulative_filled_quantity: 0.1, p_average_fill_price: 90, p_venue_updated_at: 150 });
  assert.deepEqual(await state(), { status: "partially-filled", filled_quantity: 0.4, average_fill_price: 100, actual_fees: 0.002, venue_updated_at: 200 }, "a stale acknowledgement cannot regress fill, status, price or venue clock");
  await transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "cancelled", p_cumulative_filled_quantity: 0.4, p_venue_updated_at: 300 });
  assert.equal((await state()).status, "cancelled");
  assert.equal(await planStatus(), "PARTIALLY_FILLED", "a partially filled IOC remains visibly partially filled after cancellation");
  await transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "partially-filled", p_fill_delta: 0.6, p_average_fill_price: 110, p_actual_fee_delta: 0.01, p_venue_updated_at: 400 });
  assert.deepEqual(await state(), { status: "filled", filled_quantity: 1, average_fill_price: 106, actual_fees: 0.012, venue_updated_at: 400 });
  assert.equal(await planStatus(), "FILLED");
  await transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "cancelled", p_cumulative_filled_quantity: 0.2, p_venue_updated_at: 350 });
  assert.equal((await state()).status, "filled", "terminal FILLED cannot regress to cancellation");
  assert.equal(await planStatus(), "FILLED", "terminal follower FILLED cannot regress");

  await assert.rejects(
    () => transition({ p_order_id: orderId, p_account_id: wrongAccountId, p_reported_status: "filled" }),
    /ownership mismatch/i,
    "the transition RPC is scoped to the owning account",
  );

  const secondOrderId = "77777777-7777-4777-8777-777777777777";
  const secondPlanId = "88888888-8888-4888-8888-888888888888";
  await db.query("insert into public.execution_orders(id,user_id,account_id,quantity,status) values($1,$2,$3,1,'accepted')", [secondOrderId, userId, accountId]);
  await db.query("insert into public.follower_execution_plans(id,follower_user_id,broker_connection_id) values($1,$2,$3)", [secondPlanId, userId, connectionId]);
  await transition({ p_order_id: secondOrderId, p_account_id: accountId, p_reported_status: "cancelled", p_cumulative_filled_quantity: 0, p_follower_plan_id: secondPlanId });
  assert.equal((await db.query("select execution_status from public.follower_execution_plans where id=$1", [secondPlanId])).rows[0].execution_status, "CANCELLED");
  await Promise.all([
    transition({ p_order_id: secondOrderId, p_account_id: accountId, p_reported_status: "partially-filled", p_fill_delta: 0.2, p_venue_updated_at: 500 }),
    transition({ p_order_id: secondOrderId, p_account_id: accountId, p_reported_status: "partially-filled", p_fill_delta: 0.3, p_venue_updated_at: 500 }),
  ]);
  const secondState = (await db.query("select status,filled_quantity::float8 as filled_quantity from public.execution_orders where id=$1", [secondOrderId])).rows[0];
  assert.deepEqual(secondState, { status: "cancelled", filled_quantity: 0.5 }, "row locking prevents concurrent fill deltas from being lost");
  assert.equal((await db.query("select execution_status from public.follower_execution_plans where id=$1", [secondPlanId])).rows[0].execution_status, "PARTIALLY_FILLED", "a real late fill supersedes a terminal zero-fill plan presentation");

  await db.exec("set request.jwt.claim.role='authenticated'");
  await assert.rejects(() => transition({ p_order_id: orderId, p_account_id: accountId, p_reported_status: "filled" }), /service identity required/i);
  await db.close();

  const workerSource = fs.readFileSync(new URL("../server/cloud-execution/worker.js", import.meta.url), "utf8");
  const supervisorSource = fs.readFileSync(new URL("../server/cloud-execution/connection-supervisor.js", import.meta.url), "utf8");
  assert.ok((workerSource.match(/applyExecutionOrderState\(/g) || []).length >= 2, "direct and group worker persistence use the transition RPC");
  assert.ok((supervisorSource.match(/applyExecutionOrderState\(/g) || []).length >= 2, "private order and fill events use the transition RPC");
});

test("only failed or unfilled parent dependencies cancel strategy child commands", () => {
  for (const reason of ["PARENT_ENTRY_FAILED", "PARENT_ENTRY_UNFILLED", "PARENT_GROUP_ENTRY_FAILED", "PARENT_GROUP_ENTRY_UNFILLED"]) {
    assert.equal(strategyDependencyCancellation({ skipped: true, reason }), reason);
  }
  for (const reason of ["POSITION_ALREADY_FLAT", "DESIRED_POSITION_ALREADY_OPEN", "STALE_STRATEGY_TP_GENERATION", "TAKE_PROFIT_REPRICE_SUPERSEDED"]) {
    assert.equal(strategyDependencyCancellation({ skipped: true, reason }), null, `${reason} remains an idempotent successful no-op`);
  }
  assert.match(strategyDependencyCancellationMessage("PARENT_ENTRY_FAILED"), /parent entry command failed or was cancelled/i);
  assert.match(strategyDependencyCancellationMessage("PARENT_ENTRY_UNFILLED"), /without an executable fill/i);
  for (const status of [
    "RISK_REJECTED",
    "CONNECTION_UNHEALTHY",
    "AUTH_EXPIRED",
    "INSUFFICIENT_MARGIN",
    "SYMBOL_NOT_ALLOWED",
    "MANDATE_PAUSED",
    "VENUE_REJECTED",
    "RECONCILIATION_REQUIRED",
    "CANCELLED"
  ]) {
    assert.equal(isTerminalFollowerPlanRejection(status), true, `${status} cancels the group take-profit child`);
  }
  for (const status of ["PENDING", "QUEUED", "EXECUTED", "WORKING", "PARTIALLY_FILLED", "FILLED"]) {
    assert.equal(isTerminalFollowerPlanRejection(status), false, `${status} is not a terminal follower-plan rejection`);
  }
  assert.equal(isTerminalFollowerPlanRejection(null), false);
  const workerSource = fs.readFileSync(new URL("../server/cloud-execution/worker.js", import.meta.url), "utf8");
  assert.match(workerSource, /isTerminalFollowerPlanRejection\(parentPlan\?\.execution_status\)[^\n]+PARENT_GROUP_ENTRY_FAILED/);
  assert.match(workerSource, /\["FAILED", "REJECTED", "CANCELLED", "DEAD_LETTER"\][^\n]+parentCommand\.status/);
});

test("durable OMS acknowledgement blocks resubmission even when the command and group-plan links are missing", async () => {
  for (const grouped of [false, true]) {
    const updates = [];
    const order = {
      id: grouped ? "group-order-1" : "direct-order-1",
      user_id: grouped ? "follower-1" : "user-1",
      account_id: "account-1",
      client_order_id: "bt-candidate",
      symbol: "BTCUSDT",
      strategy_target_binding_id: "binding-1",
      group_intent_id: grouped ? "group-intent-1" : null,
      mandate_id: grouped ? "mandate-1" : null
    };
    const links = grouped
      ? { execution_commands: "reverse-close-order", follower_execution_plans: null }
      : { execution_commands: null, follower_execution_plans: null };
    const worker = new BlackCloudExecutionWorker(acknowledgementGuardSupabase(order, updates, links), { workerId: "worker-test", executionEnvironment: "MAINNET_LIVE" });
    await assert.rejects(() => worker.blockAcknowledgedOrderResubmission({
      executionOrderId: links.execution_commands,
      followerPlanExecutionOrderId: links.follower_execution_plans,
      commandId: "command-1",
      followerPlanId: grouped ? "plan-1" : null,
      clientOrderId: "bt-candidate",
      account: { id: "account-1" },
      symbol: "BTCUSDT",
      orderUserId: order.user_id,
      bindingId: "binding-1",
      groupIntentId: grouped ? "group-intent-1" : null,
      mandateId: grouped ? "mandate-1" : null
    }), (error) => error.code === "STRATEGY_ACKNOWLEDGED_ORDER_RECONCILING" && error.reconciling === true);
    assert.ok(updates.some((item) => item.table === "execution_commands" && item.payload.execution_order_id === order.id));
    assert.equal(updates.some((item) => item.table === "follower_execution_plans"), grouped);
    assert.equal(links.execution_commands, order.id, "the command link is independently repaired to the final entry");
    if (grouped) assert.equal(links.follower_execution_plans, order.id, "a null follower-plan link is independently repaired even when the command previously linked the close leg");
  }
});

test("terminal take-profit failures enter deterministic safety reconciliation, not terminal failure", async () => {
  assert.equal(isTerminalTakeProfitProtectionFailure(Object.assign(new Error("quantity below minimum"), { code: "VENUE_VALIDATION_REJECTED" })), true);
  assert.equal(isTerminalTakeProfitProtectionFailure(Object.assign(new Error("temporary metadata outage"), { code: "VENUE_METADATA_RETRY", retryable: true })), false);
  assert.equal(isTerminalTakeProfitProtectionFailure(Object.assign(new Error("timeout"), { code: "BROKER_UNAVAILABLE", ambiguous: true })), false);

  const harness = executionWorkerHarness();
  harness.worker.placeStrategyOrder = async () => {
    throw Object.assign(new Error("Bybit rejected TP1 quantity."), { code: "VENUE_VALIDATION_REJECTED" });
  };
  harness.worker.handleTerminalTakeProfitProtectionFailure = async () => {
    throw Object.assign(new Error("Safety close is acknowledged and settling."), {
      code: "STRATEGY_FAIL_SAFE_FLATTEN_RECONCILING", retryable: true, reconciling: true, retryAfterSeconds: 2
    });
  };
  await harness.worker.processCommand(strategyCommand());
  assert.equal(harness.commands[0].status, "RECONCILING");
  assert.equal(harness.attempts[0].outcome, "RETRY");
  assert.equal(harness.strategyAudits[0].safe_metadata.code, "STRATEGY_FAIL_SAFE_FLATTEN_RECONCILING");
});

test("take-profit repricing is bound to the latest exact entry generation", () => {
  const context = { accountId: "account-1", strategyId: "strategy-1", bindingId: "binding-1", symbol: "BTCUSDT", side: "buy" };
  const entryA = { id: "entry-a", account_id: "account-1", strategy_automation_id: "strategy-1", strategy_target_binding_id: "binding-1", symbol: "BTCUSDT", side: "buy", reduce_only: false, status: "filled", filled_quantity: 1 };
  const entryB = { ...entryA, id: "entry-b" };
  assert.equal(isCurrentStrategyEntryGeneration("entry-b", entryB, [entryB, entryA], context), true);
  assert.equal(isCurrentStrategyEntryGeneration("entry-a", entryA, [entryB, entryA], context), false, "a delayed reprice for generation A cannot amend after generation B exists");
  assert.equal(isCurrentStrategyEntryGeneration("entry-b", { ...entryB, account_id: "other" }, [entryB], context), false);
});

test("uncertain execution outcomes remain live beyond the normal retry budget", async () => {
  const ambiguousHarness = executionWorkerHarness();
  ambiguousHarness.worker.placeStrategyOrder = async () => {
    throw Object.assign(new Error("venue acknowledgement timeout"), { code: "SUBMISSION_UNKNOWN", retryable: true, ambiguous: true });
  };
  await ambiguousHarness.worker.processCommand(strategyCommand({ attempt_count: 8, max_attempts: 8 }));
  assert.equal(ambiguousHarness.commands[0].status, "SUBMISSION_UNKNOWN");

  const migration = fs.readFileSync(new URL("../supabase/migrations/202608310002_black_cloud_reconciliation_liveness.sql", import.meta.url), "utf8");
  assert.match(migration, /where c\.status='RETRY'[\s\S]{0,180}c\.attempt_count >= c\.max_attempts/);
  assert.match(migration, /c\.status in \('SUBMISSION_UNKNOWN','RECONCILING'\)[\s\S]{0,120}c\.attempt_count < c\.max_attempts/);
  assert.match(migration, /c\.available_at <= now\(\)/, "durable reconciliation still honors bounded worker backoff");

  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql stable
      as $$ select coalesce(current_setting('request.jwt.claim.role', true), '') $$;
    create table public.execution_commands(
      id uuid primary key,
      command_type text not null,
      connection_id uuid,
      execution_environment text,
      status text not null,
      priority integer not null default 100,
      attempt_count integer not null default 0 check(attempt_count>=0),
      max_attempts integer not null default 8,
      available_at timestamptz not null default now(),
      locked_by text,
      locked_until timestamptz,
      fencing_token bigint,
      last_error_code text,
      last_error_message text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz
    );
    create table public.execution_command_attempts(
      id bigint generated always as identity primary key,
      command_id uuid not null,
      worker_id text,
      fencing_token bigint,
      attempt_number integer,
      outcome text,
      error_code text,
      error_message text,
      safe_details jsonb default '{}'::jsonb,
      completed_at timestamptz
    );
    create table public.worker_leases(
      lease_key text primary key,
      worker_id text,
      fencing_token bigint,
      expires_at timestamptz
    );
  `);
  await db.exec(migration);
  await db.exec("set request.jwt.claim.role='service_role'");
  const connectionId = "11111111-1111-4111-8111-111111111111";
  const retryId = "22222222-2222-4222-8222-222222222222";
  const reconcilingId = "33333333-3333-4333-8333-333333333333";
  const unknownId = "44444444-4444-4444-8444-444444444444";
  const delayedId = "55555555-5555-4555-8555-555555555555";
  for (const [id, status, availableAt] of [
    [retryId, "RETRY", "now()"],
    [reconcilingId, "RECONCILING", "now()"],
    [unknownId, "SUBMISSION_UNKNOWN", "now()"],
    [delayedId, "RECONCILING", "now()+interval '1 hour'"]
  ]) {
    await db.query(`insert into public.execution_commands(id,command_type,connection_id,execution_environment,status,attempt_count,max_attempts,available_at)
      values($1,'PLACE_ORDER',$2,'MAINNET_LIVE',$3,8,8,${availableAt})`, [id, connectionId, status]);
  }
  const claimed = await db.query("select id,status,attempt_count from public.black_cloud_claim_execution_commands('worker-test',10,60,'MAINNET_LIVE',false)");
  assert.deepEqual(new Set(claimed.rows.map((row) => row.id)), new Set([reconcilingId, unknownId]));
  assert.ok(claimed.rows.every((row) => row.status === "PROCESSING" && row.attempt_count === 9));
  const states = await db.query("select id,status from public.execution_commands order by id");
  const stateById = new Map(states.rows.map((row) => [row.id, row.status]));
  assert.equal(stateById.get(retryId), "DEAD_LETTER", "ordinary retries still exhaust");
  assert.equal(stateById.get(delayedId), "RECONCILING", "available_at prevents a reconciliation hot loop");
  await db.close();
});

test("acknowledged-order ownership is exact and follower failure statuses stay in the schema domain", () => {
  const order = {
    user_id: "user-1",
    account_id: "account-1",
    symbol: "BTCUSDT",
    strategy_target_binding_id: "binding-1",
    group_intent_id: "group-1",
    mandate_id: "mandate-1"
  };
  assert.equal(assertAcknowledgedOrderOwnership(order, {
    account: { id: "account-1" }, symbol: "BTCUSDT", orderUserId: "user-1", bindingId: "binding-1", groupIntentId: "group-1", mandateId: "mandate-1"
  }), true);
  assert.throws(() => assertAcknowledgedOrderOwnership(order, {
    account: { id: "account-2" }, symbol: "BTCUSDT", orderUserId: "user-1", bindingId: "binding-1", groupIntentId: "group-1", mandateId: "mandate-1"
  }), (error) => error.code === "STRATEGY_ACKNOWLEDGED_ORDER_OWNERSHIP_MISMATCH");
  assert.equal(followerPlanStatusForExecutionFailure("MANDATE_PAUSED"), "MANDATE_PAUSED");
  assert.equal(followerPlanStatusForExecutionFailure("INSUFFICIENT_MARGIN"), "INSUFFICIENT_MARGIN");
  assert.equal(followerPlanStatusForExecutionFailure("STRATEGY_ENTRY_FAIL_SAFE_FLATTENED"), "RECONCILIATION_REQUIRED");
  assert.equal(followerPlanStatusForExecutionFailure("VENUE_REJECTED"), "VENUE_REJECTED");
  assert.equal(hasPositiveFollowerPlanFill({ execution_status: "FILLED" }, { filled_quantity: 0 }), true);
  assert.equal(hasPositiveFollowerPlanFill({ execution_status: "VENUE_REJECTED" }, { filled_quantity: 0.01 }), true, "a late positive fill prevents follower-plan downgrade");
  assert.equal(hasPositiveFollowerPlanFill({ execution_status: "WORKING" }, { filled_quantity: 0 }), false);
});

test("an aggregate TP1 decision suppresses later targets even after TP1 has already flattened the position", () => {
  const decision = { mode: "AGGREGATED_TP1", primaryTargetId: "TP1", terminalEntryQuantity: 0.001 };
  assert.equal(isAggregatedTargetSuppressed(decision, "TP1"), false);
  for (const targetId of ["TP2", "TP3", "TP4", "TP5", "TP6", "TP7"]) {
    assert.equal(isAggregatedTargetSuppressed(decision, targetId), true);
  }
  assert.equal(isAggregatedTargetSuppressed({ ...decision, mode: "FULL" }, "TP2"), false);
  assert.equal(isAggregatedTargetSuppressed(null, "TP2"), false);
});

test("worker source preserves group routing, aggregate-plan terminalization, parent links, and entry reconciliation budget", () => {
  const workerSource = fs.readFileSync(new URL("../server/cloud-execution/worker.js", import.meta.url), "utf8");
  const strategyWorkerSource = fs.readFileSync(new URL("./strategy-automation-worker.ts", import.meta.url), "utf8");
  assert.match(workerSource, /PLACE_ORDER" && command\.follower_plan_id[^\n]+placeFollowerOrder/);
  assert.match(workerSource, /execution_status: "EXECUTED"[\s\S]{0,350}reason: "TP_LADDER_AGGREGATED_TO_TP1"/);
  assert.match(workerSource, /linkCommand: false/);
  assert.match(workerSource, /linkPlan: false/);
  assert.match(workerSource, /linkPlan: !strategyReverseClose/);
  assert.match(workerSource, /STRATEGY_FAIL_SAFE_FLATTEN_SUBMITTED/);
  assert.match(workerSource, /closeOnTrigger: true/);
  assert.match(workerSource, /isTerminalFollowerPlanRejection\(parentPlan\?\.execution_status\)[^\n]+PARENT_GROUP_ENTRY_FAILED[\s\S]{0,120}if \(!parentPlan\?\.execution_order_id\)/);
  assert.equal(workerSource.includes("remainingQuantity: position.quantity"), false, "TP mode is frozen from terminal original fill, never recomputed from a shrinking remainder");
  assert.match(workerSource, /takeProfitProtectionDecision: decision/);
  assert.match(workerSource, /STRATEGY_SPOT_TP_PROTECTION_UNSUPPORTED/);
  assert.match(workerSource, /parentConflictResolution !== "CLOSE_THEN_REVERSE"[\s\S]{0,180}PARENT_GROUP_ENTRY_UNFILLED/);
  assert.match(workerSource, /if \(hasPositiveFill\)[\s\S]{0,500}applyExecutionOrderState/);
  assert.match(workerSource, /postFillCommandFailure:/);
  assert.equal(workerSource.includes("roundedQuantity: 0"), false, "the Bybit close-all request uses qty zero, but its durable OMS record retains the last positive owned quantity");
  assert.match(strategyWorkerSource, /maxAttempts: action === "ENTRY" \|\| action === "REVERSE" \? 100 : 8/);
});

test("strategy command audits expose only safe execution context", () => {
  assert.deepEqual(strategyCommandAuditMetadata({
    command_type: "PLACE_ORDER",
    payload: { action: "TAKE_PROFIT", direction: "short", symbol: "btc/usdt", targetId: "tp1" }
  }, { code: "PARENT_ENTRY_FAILED", commandStatus: "CANCELLED" }), {
    code: "PARENT_ENTRY_FAILED",
    commandStatus: "CANCELLED",
    commandType: "PLACE_ORDER",
    action: "TAKE_PROFIT",
    direction: "short",
    symbol: "BTCUSDT",
    targetId: "TP1",
    retryable: false,
    ambiguous: false
  });
});

test("failed parent entry produces a CANCELLED child command and binding-scoped strategy audit", async () => {
  const harness = executionWorkerHarness();
  harness.worker.placeStrategyOrder = async () => ({ skipped: true, reason: "PARENT_ENTRY_FAILED" });
  await harness.worker.processCommand(strategyCommand());

  assert.equal(harness.commands.length, 1);
  assert.equal(harness.commands[0].status, "CANCELLED");
  assert.equal(harness.commands[0].options.errorCode, "PARENT_ENTRY_FAILED");
  assert.equal(harness.attempts[0].outcome, "FAILED");
  assert.equal(harness.executionAudits[0].eventType, "STRATEGY_DEPENDENCY_CANCELLED");
  assert.equal(harness.strategyAudits[0].event_type, "STRATEGY_EXECUTION_DEPENDENCY_CANCELLED");
  assert.equal(harness.strategyAudits[0].binding_id, "binding-1");
  assert.deepEqual(
    pick(harness.strategyAudits[0].safe_metadata, ["code", "action", "direction", "symbol", "targetId"]),
    { code: "PARENT_ENTRY_FAILED", action: "TAKE_PROFIT", direction: "short", symbol: "BTCUSDT", targetId: "TP1" }
  );
  assert.equal(harness.worker.diagnostics().counters.commandsCancelled, 1);
  assert.equal(harness.worker.diagnostics().counters.commandsSucceeded, 0);
});

test("already-flat strategy no-op remains SUCCEEDED", async () => {
  const harness = executionWorkerHarness();
  harness.worker.placeStrategyOrder = async () => ({ skipped: true, reason: "POSITION_ALREADY_FLAT" });
  await harness.worker.processCommand(strategyCommand({ payload: { action: "CLOSE", direction: "short", symbol: "BTCUSDT" } }));
  assert.equal(harness.commands[0].status, "SUCCEEDED");
  assert.equal(harness.attempts[0].outcome, "SUCCEEDED");
  assert.equal(harness.strategyAudits.length, 0);
});

test("terminal and retryable strategy failures are mirrored into Strategy Lab audit events", async () => {
  for (const retryable of [false, true]) {
    const harness = executionWorkerHarness();
    harness.worker.placeStrategyOrder = async () => {
      throw Object.assign(new Error(retryable ? "Temporary venue metadata outage." : "Target quantity is below the venue step."), {
        code: retryable ? "VENUE_METADATA_RETRY" : "STRATEGY_QUANTITY_BELOW_VENUE_STEP",
        retryable
      });
    };
    await harness.worker.processCommand(strategyCommand({ payload: { action: "ENTRY", direction: "long", symbol: "BTCUSDT" } }));
    assert.equal(harness.commands[0].status, retryable ? "RETRY" : "FAILED");
    assert.equal(harness.strategyAudits[0].event_type, retryable ? "STRATEGY_EXECUTION_COMMAND_RETRY" : "STRATEGY_EXECUTION_COMMAND_FAILED");
    assert.equal(harness.strategyAudits[0].safe_metadata.action, "ENTRY");
    assert.equal(harness.strategyAudits[0].safe_metadata.direction, "long");
    assert.equal(harness.strategyAudits[0].safe_metadata.symbol, "BTCUSDT");
    assert.equal(harness.strategyAudits[0].safe_metadata.retryable, retryable);
  }
});

test("strategy retry audits mirror once and then wait for the terminal outcome", async () => {
  const retryHarness = executionWorkerHarness();
  retryHarness.worker.placeStrategyOrder = async () => {
    throw Object.assign(new Error("Temporary venue metadata outage."), { code: "VENUE_METADATA_RETRY", retryable: true });
  };
  await retryHarness.worker.processCommand(strategyCommand({ attempt_count: 2, max_attempts: 8 }));
  assert.equal(retryHarness.commands[0].status, "RETRY");
  assert.equal(retryHarness.strategyAudits.length, 0, "later retries do not flood the immutable Strategy Lab log");
  assert.equal(retryHarness.executionAudits.length, 1, "the internal execution audit still records every attempt");

  const exhaustedHarness = executionWorkerHarness();
  exhaustedHarness.worker.placeStrategyOrder = retryHarness.worker.placeStrategyOrder;
  await exhaustedHarness.worker.processCommand(strategyCommand({ attempt_count: 8, max_attempts: 8 }));
  assert.equal(exhaustedHarness.commands[0].status, "DEAD_LETTER");
  assert.equal(exhaustedHarness.strategyAudits.length, 1, "the terminal exhausted outcome remains visible in Strategy Lab");
  assert.equal(exhaustedHarness.strategyAudits[0].event_type, "STRATEGY_EXECUTION_COMMAND_FAILED");
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

function executionWorkerHarness() {
  const strategyAudits = [];
  const attempts = [];
  const commands = [];
  const executionAudits = [];
  const supabase = {
    from(table) {
      assert.equal(table, "strategy_automation_audit_events");
      return {
        insert: async (row) => {
          strategyAudits.push(row);
          return { error: null };
        }
      };
    }
  };
  const worker = new BlackCloudExecutionWorker(supabase, { workerId: "worker-test", executionEnvironment: "MAINNET_LIVE" });
  worker.clockHealth = { status: "HEALTHY" };
  worker.repository = {
    acquireLease: async () => ({ fencing_token: 9 }),
    startAttempt: async () => "attempt-1",
    finishAttempt: async (_id, outcome, details) => attempts.push({ outcome, details }),
    finishCommand: async (_id, _token, status, options = {}) => commands.push({ status, options }),
    audit: async (event) => executionAudits.push(event)
  };
  return { worker, strategyAudits, attempts, commands, executionAudits };
}

function strategyCommand(overrides = {}) {
  return {
    id: "command-1",
    command_type: "PLACE_ORDER",
    user_id: "user-1",
    connection_id: "connection-1",
    strategy_automation_id: "strategy-1",
    strategy_target_binding_id: "binding-1",
    group_intent_id: null,
    follower_plan_id: null,
    attempt_count: 1,
    max_attempts: 8,
    payload: { action: "TAKE_PROFIT", direction: "short", symbol: "BTCUSDT", targetId: "TP1" },
    ...overrides
  };
}

function acknowledgementGuardSupabase(order, updates, links = { execution_commands: null, follower_execution_plans: null }) {
  return {
    from(table) {
      const state = { table, payload: null, filters: [] };
      const builder = {
        select() { return builder; },
        update(payload) { state.payload = payload; return builder; },
        eq(column, value) { state.filters.push([column, value]); return builder; },
        is(column, value) { state.filters.push([column, value]); return builder; },
        async maybeSingle() {
          if (table === "execution_orders") return { data: order, error: null };
          if (table === "execution_commands" || table === "follower_execution_plans") return { data: { execution_order_id: links[table] }, error: null };
          return { data: null, error: null };
        },
        then(resolve, reject) {
          if (state.payload) {
            updates.push({ table, payload: state.payload, filters: state.filters });
            if (table === "execution_commands" || table === "follower_execution_plans") links[table] = state.payload.execution_order_id;
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
      };
      return builder;
    }
  };
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
