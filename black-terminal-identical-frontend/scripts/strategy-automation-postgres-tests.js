import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/202608220001_black_core_strategy_automation.sql"), "utf8")
  .replace("create extension if not exists pgcrypto;", "-- pgcrypto is preinstalled in production; PGlite exposes gen_random_uuid in core");
const draftMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608230001_my_strategy_draft_version_model.sql"), "utf8");
const demoExecutionMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608230002_bybit_demo_strategy_execution.sql"), "utf8");
const bcrdaContainmentMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608230003_bcrda_signal_integrity_containment.sql"), "utf8");
const archiveMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608240001_strategy_automation_archive.sql"), "utf8");
const brokerGroupExecutionMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608240002_strategy_broker_group_execution.sql"), "utf8");
const nineTargetMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608290001_strategy_lab_nine_target_capacity.sql"), "utf8");
const superAtrRuntimeMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608290003_strategy_superatr_runtime_kind.sql"), "utf8");
const sideLeverageMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608300001_strategy_target_side_leverage.sql"), "utf8");
const db = new PGlite();

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role',true),'') $$;
  create table public.connectivity_connections(id uuid primary key);
  create table public.exchange_accounts(id uuid primary key);
  create table public.investment_groups(id uuid primary key);
  create table public.execution_orders(id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());
  create table public.execution_fills(id uuid primary key default gen_random_uuid(), filled_at timestamptz not null default now());
  create table public.account_positions(id uuid primary key default gen_random_uuid(), quantity numeric not null default 0, updated_at timestamptz not null default now());
  create table public.group_trade_intents(id uuid primary key default gen_random_uuid(), client_intent_id text not null default gen_random_uuid()::text, created_at timestamptz not null default now());
`);
await db.exec(migration);
await db.exec(draftMigration);
await db.exec(`
  alter table public.execution_orders add column origin text not null default 'MANUAL_BLACK_TERMINAL';
  alter table public.connectivity_connections add column user_id uuid;
  alter table public.connectivity_connections add column provider text;
  alter table public.connectivity_connections add column execution_environment text;
  alter table public.connectivity_connections add column endpoint_profile text;
  alter table public.connectivity_connections add column revoked_at timestamptz;
  alter table public.connectivity_connections add column disabled_at timestamptz;
  create table public.execution_commands(
    id uuid primary key default gen_random_uuid(),
    connection_id uuid references public.connectivity_connections(id),
    command_type text not null,
    idempotency_key text not null unique,
    status text not null default 'QUEUED',
    priority integer not null default 100,
    available_at timestamptz not null default now(),
    locked_by text,
    locked_until timestamptz,
    attempt_count integer not null default 0,
    max_attempts integer not null default 5,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.broker_connection_capabilities(
    connection_id uuid primary key,
    can_place_market_orders boolean not null default false,
    can_execute_while_offline boolean not null default false,
    can_receive_group_orders boolean not null default false,
    can_withdraw boolean not null default false,
    can_transfer boolean not null default false
  );
  create table public.broker_automation_mandates(
    id uuid primary key default gen_random_uuid(), user_id uuid, connection_id uuid, broker text, account_reference text,
    subaccount_reference text, allow_read boolean, allow_trade boolean, allow_cancel boolean, allow_modify boolean,
    allow_strategy_execution boolean, allow_copy_trading boolean, allow_investment_group_execution boolean,
    allow_withdrawals boolean, max_order_notional numeric, max_position_notional numeric, max_leverage numeric,
    max_daily_loss numeric, allowed_strategies jsonb, allowed_symbols jsonb, emergency_policy jsonb, status text,
    mandate_version integer, policy_version text, security_version text, canonical_hash text, service_signature text,
    consent_evidence jsonb, accepted_at timestamptz, expires_at timestamptz, execution_environment text,
    risk_policy_version integer, revoked_at timestamptz, updated_at timestamptz default now()
  );
  create table public.broker_automation_mandate_versions(
    mandate_id uuid, user_id uuid, version integer, policy_snapshot jsonb, canonical_hash text,
    service_signature text, consent_evidence jsonb
  );
  create table public.broker_risk_policy_versions(
    user_id uuid, connection_id uuid, mandate_id uuid, execution_environment text, policy_version integer,
    policy_snapshot jsonb, canonical_hash text, service_signature text, confirmation_evidence jsonb
  );
  create table public.connection_audit_events(
    user_id uuid, connection_id uuid, mandate_id uuid, event_type text, message text, safe_metadata jsonb
  );
`);
await db.exec(demoExecutionMigration);
await db.exec(bcrdaContainmentMigration);
await db.exec(archiveMigration);
await db.exec(brokerGroupExecutionMigration);
await db.exec(nineTargetMigration);
await db.exec(superAtrRuntimeMigration);
await db.exec(sideLeverageMigration);
await db.exec("set request.jwt.claim.role='service_role'");

const ownerId = crypto.randomUUID();
await db.query("insert into auth.users(id) values($1)", [ownerId]);
const blockedBcrdaDefinition = { runtimeKind: "external-signals", symbol: "BTCUSDT", timeframe: "4h", marketType: "FUTURES", exchange: "bybit", indicator: { indicatorId: "black-core-dda-pro", name: "BC-RDA", runtimeStatus: "CERTIFIED" }, settings: { signalModelVersion: "BC_RDA_CAUSAL_V2" } };
await assert.rejects(
  () => db.query("insert into public.strategy_automation_strategies(owner_user_id,name,runtime_kind,symbol,timeframe,market_type,definition,status,request_hash) values($1,'Blocked BC-RDA','external-signals','BTCUSDT','4h','FUTURES',$2::jsonb,'PAPER_ACTIVE',$3)", [ownerId, json(blockedBcrdaDefinition), sha(blockedBcrdaDefinition)]),
  /BC_RDA_SIGNAL_INTEGRITY_BLOCKED/i,
  "database activation guard rejects a client-forged BC-RDA certification"
);
const containedDraft = await call("insert into public.strategy_automation_strategies(owner_user_id,name,runtime_kind,symbol,timeframe,market_type,definition,draft_definition,status,request_hash) values($1,'Contained BC-RDA','external-signals','BTCUSDT','4h','FUTURES',$2::jsonb,$2::jsonb,'DRAFT',$3) returning id,signal_integrity_status,performance_statistics_status", [ownerId, json(blockedBcrdaDefinition), sha({ draft: blockedBcrdaDefinition })]);
assert.equal(containedDraft.signal_integrity_status, "SOURCE_CERTIFIED_AUTOMATION_BLOCKED");
assert.equal(containedDraft.performance_statistics_status, "CAUSAL_MODEL_ONLY");
await assert.rejects(() => db.query("update public.strategy_automation_strategies set status='PAPER_ACTIVE' where id=$1", [containedDraft.id]), /BC_RDA_SIGNAL_INTEGRITY_BLOCKED/i);
const demoMandateConnectionId = crypto.randomUUID();
await db.query("insert into public.connectivity_connections(id,user_id,provider,execution_environment,endpoint_profile) values($1,$2,'bybit','DEMO','GLOBAL')", [demoMandateConnectionId, ownerId]);
await db.query("insert into public.broker_connection_capabilities(connection_id,can_place_market_orders,can_execute_while_offline,can_withdraw,can_transfer) values($1,true,true,false,false)", [demoMandateConnectionId]);
const mandateAcceptedAt = new Date().toISOString();
const mandatePolicy = { executionEnvironment: "DEMO", broker: "bybit", accountReference: "Demo", allowStrategyExecution: true, allowCopyTrading: false, allowInvestmentGroupExecution: false, allowWithdrawals: false, allowTransfers: false, allowedStrategies: [], allowedSymbols: ["BTCUSDT"], emergencyPolicy: { preserveProtectiveOrders: true }, mandateVersion: 1, riskPolicyVersion: 1, policyVersion: "demo-v1", securityVersion: "security-v1", acceptedAt: mandateAcceptedAt };
const mandateEvidence = { action: "ACTIVATE_BYBIT_DEMO_STRATEGY_EXECUTION", executionEnvironment: "DEMO", acceptedAt: mandateAcceptedAt, persistentAfterLogout: true };
const mandateRisk = { maxDailyLoss: 500, allowedSymbols: ["BTCUSDT"] };
const callDemoMandate = (evidence) => call("select public.black_cloud_activate_automation_mandate_v2($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7::jsonb,$8,$9) as result", [ownerId, demoMandateConnectionId, json(mandatePolicy), sha(mandatePolicy), sha("mandate-signature"), json(evidence), json(mandateRisk), sha(mandateRisk), sha("risk-signature")]);
await assert.rejects(() => callDemoMandate({ ...mandateEvidence, action: "ENABLE OFFLINE CLOUD EXECUTION" }), /strategy activation evidence missing/i, "the obsolete phrase is rejected at the database boundary");
await callDemoMandate(mandateEvidence);
assert.equal(await scalar("select execution_environment as value from public.broker_automation_mandates where connection_id=$1 and status='ACTIVE'", [demoMandateConnectionId]), "DEMO");
assert.equal(await scalar("select allow_strategy_execution as value from public.broker_automation_mandates where connection_id=$1 and status='ACTIVE'", [demoMandateConnectionId]), true);
assert.equal(await scalar("select allow_withdrawals as value from public.broker_automation_mandates where connection_id=$1 and status='ACTIVE'", [demoMandateConnectionId]), false);
const mainnetMandateConnectionId = crypto.randomUUID();
await db.query("insert into public.connectivity_connections(id,user_id,provider,execution_environment,endpoint_profile) values($1,$2,'bybit','MAINNET_LIVE','GLOBAL')", [mainnetMandateConnectionId, ownerId]);
await db.query("insert into public.broker_connection_capabilities(connection_id,can_place_market_orders,can_execute_while_offline,can_receive_group_orders,can_withdraw,can_transfer) values($1,true,true,true,false,false)", [mainnetMandateConnectionId]);
const mainnetPolicy = { ...mandatePolicy, executionEnvironment: "MAINNET_LIVE", accountReference: "Small-funds audit", allowInvestmentGroupExecution: true, mandateVersion: 1, riskPolicyVersion: 1, policyVersion: "mainnet-v1" };
const mainnetEvidence = { ...mandateEvidence, action: "ACTIVATE_BYBIT_MAINNET_STRATEGY_EXECUTION", executionEnvironment: "MAINNET_LIVE" };
await call("select public.black_cloud_activate_automation_mandate_v2($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7::jsonb,$8,$9) as result", [ownerId, mainnetMandateConnectionId, json(mainnetPolicy), sha(mainnetPolicy), sha("mainnet-mandate-signature"), json(mainnetEvidence), json(mandateRisk), sha(mandateRisk), sha("mainnet-risk-signature")]);
assert.equal(await scalar("select execution_environment as value from public.broker_automation_mandates where connection_id=$1 and status='ACTIVE'", [mainnetMandateConnectionId]), "MAINNET_LIVE");
assert.equal(await scalar("select allow_investment_group_execution as value from public.broker_automation_mandates where connection_id=$1 and status='ACTIVE'", [mainnetMandateConnectionId]), true);
assert.equal(await scalar("select allow_withdrawals as value from public.broker_automation_mandates where connection_id=$1 and status='ACTIVE'", [mainnetMandateConnectionId]), false);
await db.query("insert into public.execution_commands(connection_id,command_type,idempotency_key) values($1,'SYNC_ACCOUNT','claim-demo'),($2,'SYNC_ACCOUNT','claim-mainnet')", [demoMandateConnectionId, mainnetMandateConnectionId]);
const demoClaims = await db.query("select idempotency_key from public.black_cloud_claim_execution_commands('demo-worker',10,45,'DEMO',false)");
assert.deepEqual(demoClaims.rows.map((row) => row.idempotency_key), ["claim-demo"], "the Demo worker claims only Demo-bound commands");
const mainnetClaims = await db.query("select idempotency_key from public.black_cloud_claim_execution_commands('mainnet-worker',10,45,'MAINNET_LIVE',true)");
assert.deepEqual(mainnetClaims.rows.map((row) => row.idempotency_key), ["claim-mainnet"], "the Mainnet worker claims only Mainnet-bound commands when no global command exists");
const definition = { runtimeKind: "builtin-adaptive-swing", symbol: "BTCUSDT", timeframe: "4h", marketType: "FUTURES", exchange: "bybit", settings: {}, execution: {} };
const globalPolicy = policy({ strategyAllocationValue: 100, tradeAmountValue: 100, maximumLeverage: 10, maximumPositionPercent: 100, maximumExposurePercent: 100, maximumDailyLoss: 1000000, maximumDrawdown: 100, maximumPositions: 100 });
const paperPolicy = policy({ strategyAllocationValue: 100, tradeAmountValue: 10, maximumLeverage: 3, maximumPositionPercent: 25, maximumExposurePercent: 100, maximumDailyLoss: 500, maximumDrawdown: 20, maximumPositions: 1 });
const createHash = sha({ name: "BC-RDA Four Hour", definition, globalPolicy, paperPolicy });
const createKey = "strategy-create-test-0001";

const created = await call("select public.black_core_create_strategy($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7) as result", [ownerId, "BC-RDA Four Hour", json(definition), json(globalPolicy), json(paperPolicy), createHash, createKey]);
const strategyId = created.result.strategyId;
assert.ok(strategyId, "named strategy creation returns a durable identity");
const replay = await call("select public.black_core_create_strategy($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7) as result", [ownerId, "BC-RDA Four Hour", json(definition), json(globalPolicy), json(paperPolicy), createHash, createKey]);
assert.equal(replay.result.strategyId, strategyId);
assert.equal(replay.result.idempotent, true);
await assert.rejects(() => call("select public.black_core_create_strategy($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)", [ownerId, "Different payload", json(definition), json(globalPolicy), json(paperPolicy), sha("different"), createKey]), /idempotency key payload mismatch/i);

assert.equal((await scalar("select count(*)::int as value from public.strategy_paper_accounts where strategy_id=$1", [strategyId])), 1, "Paper Target is created separately");
assert.equal((await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1", [strategyId])), 0, "nine empty UI slots create zero target rows");

const connectionIds = [];
for (let slot = 1; slot <= 9; slot += 1) {
  const connectionId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  connectionIds.push(connectionId);
  await db.query("insert into public.connectivity_connections(id) values($1)", [connectionId]);
  await db.query("insert into public.exchange_accounts(id) values($1)", [accountId]);
  const livePolicy = policy({ strategyAllocationValue: 0, tradeAmountValue: 0, maximumLeverage: 1, maximumPositionPercent: 0, maximumExposurePercent: 0, maximumDailyLoss: 0, maximumDrawdown: 0, maximumPositions: 1 });
  const policyHash = sha(livePolicy);
  const requestHash = sha({ strategyId, strategyVersion: 1, slotIndex: slot, targetType: "BROKER_ACCOUNT", targetId: connectionId, marketType: "FUTURES", policy: livePolicy });
  const result = await call("select public.black_core_add_strategy_target($1,$2,1,$3,'BROKER_ACCOUNT',$4,$4,$5,null,'FUTURES',$6::jsonb,$7::jsonb,$8,$9,$10) as result", [ownerId, strategyId, slot, connectionId, accountId, json(livePolicy), json({ eligible: true }), policyHash, requestHash, `target-add-test-${slot}`]);
  assert.ok(result.result.bindingId);
}
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and status<>'DISCONNECTED'", [strategyId]), 9);

const tenthConnection = crypto.randomUUID();
const tenthAccount = crypto.randomUUID();
await db.query("insert into public.connectivity_connections(id) values($1)", [tenthConnection]);
await db.query("insert into public.exchange_accounts(id) values($1)", [tenthAccount]);
const zeroPolicy = policy({ strategyAllocationValue: 0, tradeAmountValue: 0, maximumLeverage: 1, maximumPositionPercent: 0, maximumExposurePercent: 0, maximumDailyLoss: 0, maximumDrawdown: 0, maximumPositions: 1 });
await assert.rejects(() => call("select public.black_core_add_strategy_target($1,$2,1,1,'BROKER_ACCOUNT',$3,$3,$4,null,'FUTURES',$5::jsonb,'{}'::jsonb,$6,$7,$8)", [ownerId, strategyId, tenthConnection, tenthAccount, json(zeroPolicy), sha(zeroPolicy), sha("tenth"), "target-add-test-10"]), /capacity|constraint/i);

const fifth = await call("select id,row_version from public.strategy_target_bindings where strategy_id=$1 and slot_index=5", [strategyId]);
const disconnectHash = sha({ action: "DISCONNECT", expectedVersion: Number(fifth.row_version), disconnectPolicy: "DETACH_MANUAL" });
const disconnectKey = "target-disconnect-test-0001";
const disconnect = () => call("select public.black_core_control_strategy_target($1,$2,$3,$4,'DISCONNECT','{}'::jsonb,'DETACH_MANUAL',$5,$6) as result", [ownerId, strategyId, fifth.id, Number(fifth.row_version), disconnectHash, disconnectKey]);
await disconnect();
const disconnectReplay = await disconnect();
assert.equal(disconnectReplay.result.idempotent, true, "disconnect retry remains idempotent after the binding is inactive");
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and status<>'DISCONNECTED'", [strategyId]), 8, "disconnect returns one slot to EMPTY without deleting history");

const replacementPolicyHash = sha(zeroPolicy);
await call("select public.black_core_add_strategy_target($1,$2,1,5,'BROKER_ACCOUNT',$3,$3,$4,null,'FUTURES',$5::jsonb,'{}'::jsonb,$6,$7,$8) as result", [ownerId, strategyId, tenthConnection, tenthAccount, json(zeroPolicy), replacementPolicyHash, sha("replacement"), "target-add-replacement"]);
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and status<>'DISCONNECTED'", [strategyId]), 9);

const beforeReorder = await db.query("select id,slot_index,row_version from public.strategy_target_bindings where strategy_id=$1 and strategy_version=1 and slot_index in (1,2) and status<>'DISCONNECTED' order by slot_index", [strategyId]);
const reorderAssignments = beforeReorder.rows.map((row) => ({ bindingId: row.id, slotIndex: row.slot_index === 1 ? 2 : 1, expectedVersion: Number(row.row_version) }));
const reorderHash = sha({ strategyId, strategyVersion: 1, assignments: reorderAssignments });
const reorderKey = "target-reorder-test-0001";
const reorder = () => call("select public.black_core_reorder_strategy_targets($1,$2,1,$3::jsonb,$4,$5) as result", [ownerId, strategyId, json(reorderAssignments), reorderHash, reorderKey]);
await reorder();
assert.equal((await reorder()).result.idempotent, true, "slot reorder retry is idempotent");
assert.equal(await scalar("select slot_index::int as value from public.strategy_target_bindings where id=$1", [beforeReorder.rows[0].id]), 2, "reorder preserves binding identity while changing display slot");

const firstBinding = await call("select * from public.strategy_target_bindings where strategy_id=$1 and slot_index=1 and status<>'DISCONNECTED'", [strategyId]);
const fundedPolicy = policy({ strategyAllocationValue: 20, tradeAmountValue: 10, requestedLongLeverage: 5, requestedShortLeverage: 3, maximumLeverage: 5, maximumPositionPercent: 20, maximumExposurePercent: 40, maximumDailyLoss: 250, maximumDrawdown: 10, maximumPositions: 2 });
const policyExpectedVersion = Number(firstBinding.row_version);
const policyRequestHash = sha({ action: "UPDATE_POLICY", expectedVersion: policyExpectedVersion, policy: fundedPolicy });
const policyKey = "target-policy-test-0001";
await call("select public.black_core_update_strategy_target_policy($1,$2,$3,$4,$5::jsonb,$6,true,$7,$8) as result", [ownerId, strategyId, firstBinding.id, policyExpectedVersion, json(fundedPolicy), sha(fundedPolicy), policyRequestHash, policyKey]);
const policyReplay = await call("select public.black_core_update_strategy_target_policy($1,$2,$3,$4,$5::jsonb,$6,true,$7,$8) as result", [ownerId, strategyId, firstBinding.id, policyExpectedVersion, json(fundedPolicy), sha(fundedPolicy), policyRequestHash, policyKey]);
assert.equal(policyReplay.result.idempotent, true, "same optimistic policy replay is idempotent");
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_policy_versions where binding_id=$1", [firstBinding.id]), 2);
assert.equal(Number(await scalar("select requested_long_leverage as value from public.strategy_target_bindings where id=$1", [firstBinding.id])), 5, "long leverage persists in the selected execution destination");
assert.equal(Number(await scalar("select requested_short_leverage as value from public.strategy_target_bindings where id=$1", [firstBinding.id])), 3, "short leverage persists in the selected execution destination");

const pauseExpectedVersion = policyExpectedVersion + 1;
const pauseHash = sha({ action: "PAUSE", expectedVersion: pauseExpectedVersion, disconnectPolicy: null });
const pauseKey = "target-pause-test-0001";
const pause = () => call("select public.black_core_control_strategy_target($1,$2,$3,$4,'PAUSE','{}'::jsonb,null,$5,$6) as result", [ownerId, strategyId, firstBinding.id, pauseExpectedVersion, pauseHash, pauseKey]);
await pause();
assert.equal((await pause()).result.idempotent, true, "pause retry is idempotent");
assert.equal(await scalar("select status as value from public.strategy_target_bindings where id=$1", [firstBinding.id]), "PAUSED");

const resumeExpectedVersion = pauseExpectedVersion + 1;
const resumeHash = sha({ action: "RESUME", expectedVersion: resumeExpectedVersion, disconnectPolicy: null });
const resumeKey = "target-resume-test-0001";
const resume = () => call("select public.black_core_control_strategy_target($1,$2,$3,$4,'RESUME',$5::jsonb,null,$6,$7) as result", [ownerId, strategyId, firstBinding.id, resumeExpectedVersion, json({ eligible: true, checkedAt: "test" }), resumeHash, resumeKey]);
await resume();
assert.equal((await resume()).result.idempotent, true, "resume retry is idempotent");
assert.equal(await scalar("select status as value from public.strategy_target_bindings where id=$1", [firstBinding.id]), "READY");

const armExpectedVersion = resumeExpectedVersion + 1;
const armHash = sha({ action: "ARM", expectedVersion: armExpectedVersion, disconnectPolicy: null });
const arm = await call("select public.black_core_control_strategy_target($1,$2,$3,$4,'ARM',$5::jsonb,null,$6,$7) as result", [ownerId, strategyId, firstBinding.id, armExpectedVersion, json({ eligible: true, checkedAt: "test" }), armHash, "target-arm-demo-test-0001"]);
assert.equal(arm.result.status, "LIVE", "a funded, eligible demo target can be armed by the service boundary");
const secondBinding = await call("select id from public.strategy_target_bindings where strategy_id=$1 and id<>$2 and status<>'DISCONNECTED' limit 1", [strategyId, firstBinding.id]);
const armedAccountId = await scalar("select account_id as value from public.strategy_target_bindings where id=$1", [firstBinding.id]);
await assert.rejects(() => db.query("update public.strategy_target_bindings set account_id=$1,status='LIVE' where id=$2", [armedAccountId, secondBinding.id]), /idx_strategy_target_one_live_per_account|unique/i, "one demo account cannot be armed by two strategies or bindings");

await db.query("insert into public.execution_commands(command_type,idempotency_key,strategy_automation_id,strategy_target_binding_id,strategy_signal_key) values('PLACE_ORDER',$1,$2,$3,$4)", ["demo-command-1", strategyId, firstBinding.id, "closed-candle:btc:4h:1000:long"]);
await assert.rejects(() => db.query("insert into public.execution_commands(command_type,idempotency_key,strategy_automation_id,strategy_target_binding_id,strategy_signal_key) values('PLACE_ORDER',$1,$2,$3,$4)", ["demo-command-2", strategyId, firstBinding.id, "closed-candle:btc:4h:1000:long"]), /idx_execution_commands_strategy_signal|unique/i, "a confirmed strategy signal is queued once per target");
await assert.rejects(() => db.query("insert into public.execution_commands(command_type,idempotency_key,strategy_automation_id,strategy_target_binding_id,strategy_signal_key) values('SYNC_ACCOUNT',$1,$2,$3,$4)", ["demo-command-invalid", strategyId, firstBinding.id, "closed-candle:btc:4h:2000:long"]), /execution_commands_strategy_shape_check|check constraint/i, "strategy execution metadata cannot be attached to a non-order command");
await db.query("update public.strategy_target_bindings set status='PAUSED' where id=$1", [firstBinding.id]);
await db.query("update public.strategy_automation_strategies set status='PAPER_ACTIVE' where id=$1", [strategyId]);

const paper = await call("select * from public.strategy_paper_accounts where strategy_id=$1 and strategy_version=1", [strategyId]);
const topUpHash = sha({ action: "TOP_UP", expectedVersion: Number(paper.state_version), amount: 5000 });
const topUpKey = "paper-top-up-test-0001";
const topUp = () => call("select public.black_core_control_paper_target($1,$2,$3,$4,'TOP_UP',5000,$5,$6) as result", [ownerId, strategyId, paper.id, Number(paper.state_version), topUpHash, topUpKey]);
await topUp();
const topUpReplay = await topUp();
assert.equal(topUpReplay.result.idempotent, true);
assert.equal(Number(await scalar("select demo_equity::numeric as value from public.strategy_paper_accounts where id=$1", [paper.id])), 15000, "idempotent retry cannot double-top-up paper equity");

const savedDefinition = { ...definition, timeframe: "1h" };
const savedPaperPolicy = paperPolicy;
const savedHash = sha({ name: "BC-RDA One Hour", definition: savedDefinition, globalPolicy, paperPolicy: savedPaperPolicy });
await call("select public.black_core_save_strategy($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8) as result", [ownerId, strategyId, "BC-RDA One Hour", json(savedDefinition), json(globalPolicy), json(savedPaperPolicy), savedHash, "strategy-save-test-0001"]);
assert.equal(Number(await scalar("select current_version::int as value from public.strategy_automation_strategies where id=$1", [strategyId])), 2);
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and strategy_version=2", [strategyId]), 0, "new immutable version starts with nine empty live slots");
assert.equal(await scalar("select count(*)::int as value from public.strategy_paper_accounts where strategy_id=$1", [strategyId]), 2, "paper history stays version-separated");

await assert.rejects(() => db.query("update public.strategy_automation_versions set name='tampered' where strategy_id=$1 and version=1", [strategyId]), /immutable/i);

const guidedDefinition = {
  ...definition,
  indicator: { indicatorId: "adaptiveSwingStrategy", instanceId: "chart:adaptiveSwingStrategy", name: "Adaptive Swing Reversal", instanceName: "Main Instance", version: "1", settingsHash: "settings-v1", settingsSummary: "Current chart settings", alertManifestVersion: "1", runtimeVersion: "black-cloud-paper-v1", warmupBars: 240, runtimeStatus: "CERTIFIED", useCurrentChartSettings: true, alerts: [] },
  signals: { longEntry: "long-entry", shortEntry: "short-entry" },
  paper: { capitalPolicy: paperPolicy }
};
const draftHash = sha({ name: "Guided Strategy", definition: guidedDefinition, globalPolicy, state: "DRAFT" });
const guided = await call("select public.black_core_create_strategy_draft($1,$2,$3::jsonb,$4::jsonb,$5,$6) as result", [ownerId, "Guided Strategy", json(guidedDefinition), json(globalPolicy), draftHash, "guided-draft-create-1"]);
const guidedId = guided.result.strategyId;
assert.equal(await scalar("select published_version is null as value from public.strategy_automation_strategies where id=$1", [guidedId]), true, "draft creation does not publish");
assert.equal(await scalar("select running_version is null as value from public.strategy_automation_strategies where id=$1", [guidedId]), true, "draft creation does not start a runtime");
assert.equal(await scalar("select count(*)::int as value from public.strategy_paper_accounts where strategy_id=$1", [guidedId]), 0, "draft creation does not create a Paper runtime");

const superAtrDefinition = { ...guidedDefinition, runtimeKind: "builtin-superatr-seven-step" };
const superAtrHash = sha({ name: "SuperATR Draft", definition: superAtrDefinition, globalPolicy, state: "DRAFT" });
const superAtrDraft = await call("select public.black_core_create_strategy_draft($1,$2,$3::jsonb,$4::jsonb,$5,$6) as result", [ownerId, "SuperATR Draft", json(superAtrDefinition), json(globalPolicy), superAtrHash, "superatr-draft-create-1"]);
assert.equal(
  await scalar("select runtime_kind as value from public.strategy_automation_strategies where id=$1", [superAtrDraft.result.strategyId]),
  "builtin-superatr-seven-step",
  "the production runtime allowlist accepts SuperATR Strategy Lab drafts"
);

const guidedOneHour = { ...guidedDefinition, timeframe: "1h" };
await call("select public.black_core_save_strategy_draft($1,$2,$3,$4::jsonb,1) as result", [ownerId, guidedId, "Guided Strategy", json(guidedOneHour)]);
assert.equal(await scalar("select draft_revision::int as value from public.strategy_automation_strategies where id=$1", [guidedId]), 2);
assert.equal(await scalar("select running_version is null as value from public.strategy_automation_strategies where id=$1", [guidedId]), true, "saving a draft cannot start or restart Paper");

await call("select public.black_core_publish_strategy_draft($1,$2,2,$3::jsonb,$4::jsonb,$5) as result", [ownerId, guidedId, json(globalPolicy), json(paperPolicy), sha({ publish: 1 })]);
assert.equal(Number(await scalar("select published_version::int as value from public.strategy_automation_strategies where id=$1", [guidedId])), 1);
assert.equal(await scalar("select running_version is null as value from public.strategy_automation_strategies where id=$1", [guidedId]), true, "publishing cannot silently start Paper");
assert.equal(await scalar("select status as value from public.strategy_paper_accounts where strategy_id=$1 and strategy_version=1", [guidedId]), "PAUSED");

await call("select public.black_core_start_strategy_version($1,$2,1) as result", [ownerId, guidedId]);
assert.equal(Number(await scalar("select running_version::int as value from public.strategy_automation_strategies where id=$1", [guidedId])), 1);
assert.equal(await scalar("select status as value from public.strategy_paper_accounts where strategy_id=$1 and strategy_version=1", [guidedId]), "ACTIVE");

const guidedFourHour = { ...guidedDefinition, timeframe: "4h", settings: { revision: 2 } };
await call("select public.black_core_save_strategy_draft($1,$2,$3,$4::jsonb,2) as result", [ownerId, guidedId, "Guided Strategy V2", json(guidedFourHour)]);
assert.equal(Number(await scalar("select running_version::int as value from public.strategy_automation_strategies where id=$1", [guidedId])), 1, "draft edits cannot mutate the running version");
assert.equal(await scalar("select status as value from public.strategy_paper_accounts where strategy_id=$1 and strategy_version=1", [guidedId]), "ACTIVE", "draft edits cannot restart or pause the active Paper account");

await call("select public.black_core_publish_strategy_draft($1,$2,3,$3::jsonb,$4::jsonb,$5) as result", [ownerId, guidedId, json(globalPolicy), json(paperPolicy), sha({ publish: 2 })]);
assert.equal(Number(await scalar("select published_version::int as value from public.strategy_automation_strategies where id=$1", [guidedId])), 2);
assert.equal(Number(await scalar("select running_version::int as value from public.strategy_automation_strategies where id=$1", [guidedId])), 1, "a newer publication leaves the old running version untouched");
assert.equal(await scalar("select status as value from public.strategy_paper_accounts where strategy_id=$1 and strategy_version=2", [guidedId]), "PAUSED");

await call("select public.black_core_start_strategy_version($1,$2,2) as result", [ownerId, guidedId]);
assert.equal(Number(await scalar("select running_version::int as value from public.strategy_automation_strategies where id=$1", [guidedId])), 2, "explicit start performs the version transition");
assert.equal(await scalar("select status as value from public.strategy_paper_accounts where strategy_id=$1 and strategy_version=1", [guidedId]), "PAUSED");
assert.equal(await scalar("select status as value from public.strategy_paper_accounts where strategy_id=$1 and strategy_version=2", [guidedId]), "ACTIVE");

const archiveHash = sha({ action: "ARCHIVE_STRATEGY", strategyId: guidedId, expectedName: "Guided Strategy V2", expectedRevision: 3 });
const archiveKey = "strategy-archive-guided-0001";
const archive = () => call("select public.black_core_archive_strategy($1,$2,$3,3,$4,$5) as result", [ownerId, guidedId, "Guided Strategy V2", archiveHash, archiveKey]);
const archived = await archive();
assert.equal(archived.result.idempotent, false);
assert.equal((await archive()).result.idempotent, true, "strategy delete retries are idempotent");
assert.equal(await scalar("select archived_at is not null as value from public.strategy_automation_strategies where id=$1", [guidedId]), true, "deleted strategy leaves the active library scope");
assert.equal(await scalar("select status as value from public.strategy_automation_strategies where id=$1", [guidedId]), "STOPPED");
assert.equal(await scalar("select count(*)::int as value from public.strategy_paper_accounts where strategy_id=$1 and status<>'STOPPED'", [guidedId]), 0, "all Paper versions are stopped");
assert.equal(await scalar("select runtime_state as value from public.strategy_automation_runtime_state where strategy_id=$1", [guidedId]), "STOPPED");
assert.equal(await scalar("select count(*)::int as value from public.strategy_automation_versions where strategy_id=$1", [guidedId]), 2, "immutable strategy versions are retained");
assert.equal(await scalar("select count(*)::int as value from public.strategy_automation_audit_events where strategy_id=$1 and event_type='STRATEGY_ARCHIVED'", [guidedId]), 1, "archive action is audited exactly once");

await db.exec("set role anon");
await assert.rejects(() => db.query("select * from public.strategy_automation_strategies"), /permission denied/i);
await db.exec("reset role");

await db.close();
console.log("Strategy automation PostgreSQL tests PASS — Demo/Mainnet mandates, environment-partitioned claims, immutable versions, private activation, target fencing, exactly-once signals, Paper transitions, RLS and audit immutability verified.");

async function call(statement, values = []) {
  const result = await db.query(statement, values);
  assert.ok(result.rows.length, `query returned no row: ${statement}`);
  return result.rows[0];
}

async function scalar(statement, values = []) {
  return (await call(statement, values)).value;
}

function policy(overrides = {}) {
  return {
    strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY",
    strategyAllocationValue: 100,
    tradeAmountMode: "PERCENT_STRATEGY_ALLOCATION",
    tradeAmountValue: 10,
    requestedLeverage: 1,
    maximumLeverage: 3,
    maximumPositionPercent: 25,
    maximumExposurePercent: 100,
    maximumDailyLoss: 500,
    maximumDrawdown: 20,
    maximumPositions: 1,
    slippageBps: 5,
    marginMode: "CROSS",
    ...overrides
  };
}

function json(value) { return JSON.stringify(value); }
function sha(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
