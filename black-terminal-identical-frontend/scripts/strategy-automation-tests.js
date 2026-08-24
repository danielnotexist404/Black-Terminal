import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanArmLiveTarget,
  assertCanArmStrategyTarget,
  assertCertifiedStrategyDefinition,
  buildTargetSlots,
  calculateCapitalPreview,
  calculateEffectiveLeverage,
  defaultLiveCapitalPolicy,
  defaultPaperCapitalPolicy,
  demoAutomationEnabled,
  liveAutomationEnabled,
  normalizeCapitalPolicy,
  normalizeStrategyDefinition,
  normalizeStrategyName,
  riskIncrease
} from "../server/strategy-automation/domain.js";
import { strategySchemas } from "../server/strategy-automation/schemas.js";
import { normalizeStrategyPath } from "../api/strategies/[...path].js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = read("supabase/migrations/202608220001_black_core_strategy_automation.sql");
const containmentMigration = read("supabase/migrations/202608230003_bcrda_signal_integrity_containment.sql");
const archiveMigration = read("supabase/migrations/202608240001_strategy_automation_archive.sql");
const panel = read("src/modules/strategy-lab/automation/StrategyAutomationPanel.tsx");
const apiClient = read("src/modules/strategy-lab/automation/strategyAutomationApi.ts");
const worker = read("scripts/strategy-automation-worker.ts");
const compose = read("infra/black-cloud/docker-compose.yml");

assert.equal(normalizeStrategyName("  BC-RDA   Four Hour  "), "BC-RDA Four Hour");
assert.throws(() => normalizeStrategyName(""), /Name the strategy/i);
assert.throws(() => normalizeStrategyName("x".repeat(81)), /80/);

const definition = normalizeStrategyDefinition({ runtimeKind: "builtin-adaptive-swing", symbol: "btcusdt", timeframe: "4H", marketType: "futures", exchange: "BYBIT", settings: {}, execution: {} });
assert.deepEqual({ symbol: definition.symbol, timeframe: definition.timeframe, marketType: definition.marketType, exchange: definition.exchange }, { symbol: "BTCUSDT", timeframe: "4h", marketType: "FUTURES", exchange: "bybit" });
for (const timeframe of ["1s", "10s", "30s", "8h", "10t", "100t"]) assert.throws(() => normalizeStrategyDefinition({ ...definition, timeframe }), /closed-candle timeframe/i);
assert.throws(() => assertCertifiedStrategyDefinition(normalizeStrategyDefinition({ ...definition, indicator: { indicatorId: "black-core-dda-pro", name: "BC-RDA", runtimeStatus: "CERTIFIED" } })), /BC-RDA is blocked/i, "a forged runtime label cannot enable BC-RDA");

const emptySlots = buildTargetSlots([]);
assert.equal(emptySlots.length, 10);
assert.equal(emptySlots.filter((slot) => slot.state === "EMPTY").length, 10);
const occupied = Array.from({ length: 10 }, (_, index) => ({ slotIndex: index + 1, status: index === 4 ? "DISCONNECTED" : "READY", id: `binding-${index}` }));
const occupiedSlots = buildTargetSlots(occupied);
assert.equal(occupiedSlots.filter((slot) => slot.binding).length, 9);
assert.equal(occupiedSlots[4].state, "EMPTY", "disconnect returns the stable fifth slot to empty");

const livePolicy = defaultLiveCapitalPolicy("FUTURES");
assert.equal(livePolicy.strategyAllocationValue, 0);
assert.equal(livePolicy.tradeAmountValue, 0);
assert.throws(() => assertCanArmLiveTarget({ policy: livePolicy, marketType: "FUTURES", validation: { eligible: true }, environment: {} }), /cannot be armed/i);
assert.equal(liveAutomationEnabled({ STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED: "true", STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED: "false" }), false);
assert.equal(liveAutomationEnabled({ STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED: "true", STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED: "true", BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH: "true" }), false);
assert.equal(liveAutomationEnabled({ STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED: "true", STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED: "true" }), true);
assert.equal(demoAutomationEnabled({ STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true", BYBIT_DEMO_ENABLED: "true" }), true);
assert.equal(demoAutomationEnabled({ STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true", BYBIT_DEMO_ENABLED: "true", BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH: "true" }), false);
assert.doesNotThrow(() => assertCanArmStrategyTarget({ policy: paperPolicyForArm(), marketType: "FUTURES", validation: { eligible: true }, executionEnvironment: "DEMO", environment: { STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true", BYBIT_DEMO_ENABLED: "true" } }));
assert.throws(() => assertCanArmStrategyTarget({ policy: paperPolicyForArm(), marketType: "FUTURES", validation: { eligible: true }, executionEnvironment: "MAINNET_LIVE", environment: { STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true", BYBIT_DEMO_ENABLED: "true" } }), /Real-funds Mainnet/i);

const paperPolicy = defaultPaperCapitalPolicy("FUTURES");
const percentPreview = calculateCapitalPreview({ equity: 10_000, availableBalance: 8_000, policy: paperPolicy, marketType: "FUTURES" });
assert.equal(percentPreview.allocatedStrategyCapital, 10_000);
assert.equal(percentPreview.entryCapital, 1_000);
assert.equal(percentPreview.estimatedNotional, 1_000);
assert.equal(calculateCapitalPreview({ equity: 10_000, availableBalance: 0, policy: paperPolicy, marketType: "FUTURES" }).entryCapital, 0, "zero available balance can never preview executable capital");

const fixedUsdt = normalizeCapitalPolicy({ ...paperPolicy, strategyAllocationMode: "FIXED_USDT", strategyAllocationValue: 2_500, tradeAmountMode: "FIXED_USDT", tradeAmountValue: 500, requestedLeverage: 3 }, "FUTURES");
const fixedPreview = calculateCapitalPreview({ equity: 10_000, availableBalance: 10_000, policy: fixedUsdt, marketType: "FUTURES" });
assert.equal(fixedPreview.allocatedStrategyCapital, 2_500);
assert.equal(fixedPreview.entryCapital, 500);
assert.equal(fixedPreview.estimatedNotional, 1_500);

assert.equal(calculateEffectiveLeverage({ requested: 20, targetMaximum: 15, accountRiskCap: 10, groupMandateCap: 8, emsRiskCap: 6, providerCap: 12 }), 6);
const spotPolicy = defaultPaperCapitalPolicy("SPOT");
assert.equal(spotPolicy.requestedLeverage, undefined);
assert.equal(spotPolicy.maximumLeverage, undefined);
assert.equal(spotPolicy.marginMode, undefined);
const spotPreview = calculateCapitalPreview({ equity: 10_000, availableBalance: 10_000, policy: spotPolicy, marketType: "SPOT" });
assert.equal(spotPreview.effectiveLeverage, 1);
assert.equal(spotPreview.quoteAssetReserve, 1_000);
assert.equal(spotPreview.maximumBaseAssetExposure, 9_000);

assert.equal(riskIncrease(livePolicy, { ...livePolicy, strategyAllocationValue: 10 }, "FUTURES"), true);
assert.equal(riskIncrease({ ...paperPolicy, requestedLeverage: 3 }, { ...paperPolicy, requestedLeverage: 2 }, "FUTURES"), false);

assert.equal(strategySchemas.create.safeParse({ definition }).success, false, "strategy name is required before save");
assert.equal(strategySchemas.create.safeParse({ name: "Named strategy", definition }).success, true);
assert.equal(strategySchemas.archive.safeParse({ expectedName: "Named strategy", expectedRevision: 2 }).success, true);
assert.equal(strategySchemas.archive.safeParse({ expectedName: "Named strategy", expectedRevision: 2, force: true }).success, false, "archive schema rejects client-side force deletion");
assert.equal(strategySchemas.create.safeParse({ name: "Named strategy", definition, apiSecret: "forbidden" }).success, false, "strict strategy schema rejects credentials and unknown fields");
assert.deepEqual(normalizeStrategyPath(undefined, { url: "/api/strategies/00000000-0000-4000-8000-000000000001/targets" }), ["00000000-0000-4000-8000-000000000001", "targets"]);

assert.match(migration, /slot_index integer not null check \(slot_index between 1 and 10\)/);
assert.match(migration, /where status <> 'DISCONNECTED'/);
assert.match(migration, /live target capacity reached/);
assert.match(migration, /strategy service identity required/g);
assert.match(migration, /from anon,authenticated/);
assert.match(migration, /black_core_claim_strategy_runtime/);
assert.match(migration, /idempotency key payload mismatch/);
assert.match(migration, /strategy_paper_mutation_requests/);
assert.match(migration, /strategy_target_mutation_requests/);
assert.match(migration, /strategy_target_reorder_requests/);
assert.match(migration, /black_core_control_strategy_target/);
assert.match(containmentMigration, /BC_RDA_SIGNAL_INTEGRITY_BLOCKED/);
assert.match(containmentMigration, /trg_guard_bcrda_strategy_activation/);
assert.match(archiveMigration, /black_core_archive_strategy/);
assert.match(archiveMigration, /active strategy targets must be disconnected before archive/);
assert.match(archiveMigration, /pending strategy commands must settle before archive/);
assert.match(archiveMigration, /information_schema\.columns[\s\S]*execute \$pending\$/,
  "archive remains compatible when the independently deployed strategy execution linkage is absent");
assert.doesNotMatch(archiveMigration, /delete from public\./i, "strategy deletion is an audit-preserving archive");
assert.match(migration, /black_core_reorder_strategy_targets/);
assert.doesNotMatch(`${panel}\n${apiClient}`, /credential_ref|vault_secret/i, "Strategy Lab never requests or renders vault internals");
assert.doesNotMatch(panel, /percentile/i, "capital UI uses Percentage terminology only");
assert.equal((panel.match(/setInterval\(/g) || []).length, 1, "one strategy-level snapshot cadence replaces per-target polling");
assert.match(panel, /Array\.from\(\{ length: 10 \}/);
assert.match(panel, /NAME STRATEGY BEFORE SAVING/);
assert.match(panel, /RESET PAPER ACCOUNT/);
assert.match(panel, /Move target one slot left/);
assert.match(worker, /STRATEGY_AUTOMATION_REAL_FUNDS_FORBIDDEN/);
assert.match(worker, /strategy_target_binding_id/);
assert.match(worker, /execution_commands/);
assert.match(worker, /isBcrdaDefinition[\s\S]*BC_RDA_SIGNAL_INTEGRITY_BLOCKED/);
assert.doesNotMatch(worker, /placeOrder|cancelOrder|modifyOrder|execution_orders.*insert/i, "paper worker contains no broker order mutation path");
assert.match(worker, /candleClosedAt <= Date\.parse\(position\.opened_at\)/, "same-candle look-ahead exit is rejected");
assert.match(worker, /averageTrueRange\(candles, 14\)/, "volatility-target sizing is based on closed-candle ATR");
assert.match(compose, /STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED: "false"/);
assert.match(compose, /STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true"/);
assert.match(compose, /STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED: "false"/);

console.log("Strategy automation domain and security tests PASS — naming, sizing, demo-only arming, real-funds rejection, durable command emission and no-look-ahead contracts verified.");

function paperPolicyForArm() { return { ...defaultPaperCapitalPolicy("FUTURES"), maximumDailyLoss: 500, maximumDrawdown: 20 }; }

function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), "utf8"); }
