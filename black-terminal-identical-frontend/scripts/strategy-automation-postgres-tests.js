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
  create table public.account_positions(id uuid primary key default gen_random_uuid(), updated_at timestamptz not null default now());
  create table public.group_trade_intents(id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());
`);
await db.exec(migration);
await db.exec(draftMigration);
await db.exec("set request.jwt.claim.role='service_role'");

const ownerId = crypto.randomUUID();
await db.query("insert into auth.users(id) values($1)", [ownerId]);
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
assert.equal((await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1", [strategyId])), 0, "ten empty UI slots create zero target rows");

const connectionIds = [];
for (let slot = 1; slot <= 10; slot += 1) {
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
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and status<>'DISCONNECTED'", [strategyId]), 10);

const eleventhConnection = crypto.randomUUID();
const eleventhAccount = crypto.randomUUID();
await db.query("insert into public.connectivity_connections(id) values($1)", [eleventhConnection]);
await db.query("insert into public.exchange_accounts(id) values($1)", [eleventhAccount]);
const zeroPolicy = policy({ strategyAllocationValue: 0, tradeAmountValue: 0, maximumLeverage: 1, maximumPositionPercent: 0, maximumExposurePercent: 0, maximumDailyLoss: 0, maximumDrawdown: 0, maximumPositions: 1 });
await assert.rejects(() => call("select public.black_core_add_strategy_target($1,$2,1,1,'BROKER_ACCOUNT',$3,$3,$4,null,'FUTURES',$5::jsonb,'{}'::jsonb,$6,$7,$8)", [ownerId, strategyId, eleventhConnection, eleventhAccount, json(zeroPolicy), sha(zeroPolicy), sha("eleventh"), "target-add-test-11"]), /capacity|constraint/i);

const fifth = await call("select id,row_version from public.strategy_target_bindings where strategy_id=$1 and slot_index=5", [strategyId]);
const disconnectHash = sha({ action: "DISCONNECT", expectedVersion: Number(fifth.row_version), disconnectPolicy: "DETACH_MANUAL" });
const disconnectKey = "target-disconnect-test-0001";
const disconnect = () => call("select public.black_core_control_strategy_target($1,$2,$3,$4,'DISCONNECT','{}'::jsonb,'DETACH_MANUAL',$5,$6) as result", [ownerId, strategyId, fifth.id, Number(fifth.row_version), disconnectHash, disconnectKey]);
await disconnect();
const disconnectReplay = await disconnect();
assert.equal(disconnectReplay.result.idempotent, true, "disconnect retry remains idempotent after the binding is inactive");
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and status<>'DISCONNECTED'", [strategyId]), 9, "disconnect returns one slot to EMPTY without deleting history");

const replacementPolicyHash = sha(zeroPolicy);
await call("select public.black_core_add_strategy_target($1,$2,1,5,'BROKER_ACCOUNT',$3,$3,$4,null,'FUTURES',$5::jsonb,'{}'::jsonb,$6,$7,$8) as result", [ownerId, strategyId, eleventhConnection, eleventhAccount, json(zeroPolicy), replacementPolicyHash, sha("replacement"), "target-add-replacement"]);
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and status<>'DISCONNECTED'", [strategyId]), 10);

const beforeReorder = await db.query("select id,slot_index,row_version from public.strategy_target_bindings where strategy_id=$1 and strategy_version=1 and slot_index in (1,2) and status<>'DISCONNECTED' order by slot_index", [strategyId]);
const reorderAssignments = beforeReorder.rows.map((row) => ({ bindingId: row.id, slotIndex: row.slot_index === 1 ? 2 : 1, expectedVersion: Number(row.row_version) }));
const reorderHash = sha({ strategyId, strategyVersion: 1, assignments: reorderAssignments });
const reorderKey = "target-reorder-test-0001";
const reorder = () => call("select public.black_core_reorder_strategy_targets($1,$2,1,$3::jsonb,$4,$5) as result", [ownerId, strategyId, json(reorderAssignments), reorderHash, reorderKey]);
await reorder();
assert.equal((await reorder()).result.idempotent, true, "slot reorder retry is idempotent");
assert.equal(await scalar("select slot_index::int as value from public.strategy_target_bindings where id=$1", [beforeReorder.rows[0].id]), 2, "reorder preserves binding identity while changing display slot");

const firstBinding = await call("select * from public.strategy_target_bindings where strategy_id=$1 and slot_index=1 and status<>'DISCONNECTED'", [strategyId]);
const fundedPolicy = policy({ strategyAllocationValue: 20, tradeAmountValue: 10, maximumLeverage: 3, maximumPositionPercent: 20, maximumExposurePercent: 40, maximumDailyLoss: 250, maximumDrawdown: 10, maximumPositions: 2 });
const policyExpectedVersion = Number(firstBinding.row_version);
const policyRequestHash = sha({ action: "UPDATE_POLICY", expectedVersion: policyExpectedVersion, policy: fundedPolicy });
const policyKey = "target-policy-test-0001";
await call("select public.black_core_update_strategy_target_policy($1,$2,$3,$4,$5::jsonb,$6,true,$7,$8) as result", [ownerId, strategyId, firstBinding.id, policyExpectedVersion, json(fundedPolicy), sha(fundedPolicy), policyRequestHash, policyKey]);
const policyReplay = await call("select public.black_core_update_strategy_target_policy($1,$2,$3,$4,$5::jsonb,$6,true,$7,$8) as result", [ownerId, strategyId, firstBinding.id, policyExpectedVersion, json(fundedPolicy), sha(fundedPolicy), policyRequestHash, policyKey]);
assert.equal(policyReplay.result.idempotent, true, "same optimistic policy replay is idempotent");
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_policy_versions where binding_id=$1", [firstBinding.id]), 2);

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
assert.equal(await scalar("select count(*)::int as value from public.strategy_target_bindings where strategy_id=$1 and strategy_version=2", [strategyId]), 0, "new immutable version starts with ten empty live slots");
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

await db.exec("set role anon");
await assert.rejects(() => db.query("select * from public.strategy_automation_strategies"), /permission denied/i);
await db.exec("reset role");

await db.close();
console.log("Strategy automation PostgreSQL tests PASS — naming, immutable versions, draft/published/running isolation, explicit Paper transitions, 10-slot capacity, slot reuse, optimistic versioning, idempotency, RLS and audit immutability verified.");

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
