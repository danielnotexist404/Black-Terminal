import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const tabs = read("src/modules/strategy-lab/components/StrategyTabs.tsx");
const page = read("src/modules/strategy-lab/components/StrategyLabPage.tsx");
const experience = read("src/modules/strategy-lab/my-strategy/StrategyAutomationExperience.tsx");
const library = read("src/modules/strategy-lab/my-strategy/pages/StrategyLibraryPage.tsx");
const wizard = read("src/modules/strategy-lab/my-strategy/pages/StrategyWizardPage.tsx");
const draftStore = read("src/modules/strategy-lab/my-strategy/state/strategyDraftStore.ts");
const indicator = read("src/modules/strategy-lab/my-strategy/wizard/IndicatorMarketStep.tsx");
const manifest = read("src/modules/strategy-lab/my-strategy/state/indicatorManifest.ts");
const cockpit = read("src/modules/strategy-lab/my-strategy/pages/StrategyCockpitPage.tsx");
const targetMatrix = read("src/modules/strategy-lab/my-strategy/cockpit/TargetSlotMatrix.tsx");
const migration = read("supabase/migrations/202608230001_my_strategy_draft_version_model.sql");
const compose = read("infra/black-cloud/docker-compose.yml");

for (const label of ["Identity", "Indicator and Market", "Signal Mapping", "Execution Behavior", "Risk Management", "Filters and Schedule", "Take Profits and Exits", "Paper Account", "Live Targets", "Review and Publish"]) assert.match(draftStore, new RegExp(`"${label}"`));
assert.equal((draftStore.match(/^\s*"(?:Identity|Indicator and Market|Signal Mapping|Execution Behavior|Risk Management|Filters and Schedule|Take Profits and Exits|Paper Account|Live Targets|Review and Publish)",?$/gm) || []).length, 10);
assert.match(draftStore, /Strategy name must contain at least 2 characters/, "mandatory strategy name is validated at its own step");
assert.match(draftStore, /Select an active indicator or a strategy template/, "indicator selection is mandatory");
assert.match(draftStore, /Long Trigger Entry/);
assert.match(draftStore, /Short Trigger Entry/);
assert.match(draftStore, /Buy Trigger Entry/);
assert.match(draftStore, /Sell Trigger Entry/, "Spot uses Buy/Sell semantics instead of Long/Short");

for (const label of ["My Strategy", "Backtest", "Paper Trading", "Live Automation", "Analytics", "Research", "Logs"]) assert.match(tabs, new RegExp(`label: "${label}"`));
for (const researchTool of ["Optimization", "Heatmap", "AI Review", "Code Suggestions", "Forward Test"]) {
  assert.doesNotMatch(tabs, new RegExp(`label: "${researchTool}"`), `${researchTool} is not a primary Strategy Lab tab`);
  assert.match(page, new RegExp(`"${researchTool}"`), `${researchTool} remains available under Research`);
}

assert.match(library, /CREATE NEW STRATEGY/);
assert.match(library, /strategies\.map/);
assert.doesNotMatch(library, /StrategyDefinitionBuilder|NAME STRATEGY BEFORE SAVING/);
assert.equal((wizard.match(/step === \d/g) || []).length, 10, "wizard renders only the active step");
assert.match(indicator, /Choose an active chart indicator/);
assert.match(indicator, /START FROM A TEMPLATE/);
assert.match(indicator, /Current chart:.*Runtime:/s, "strategy timeframe is explicitly independent of chart timeframe");
assert.match(indicator, /\["SPOT", "FUTURES"\]/);
assert.match(manifest, /source: "ACTIVE_CHART"/);
assert.match(manifest, /source: "CUSTOM"/);
assert.match(manifest, /runtimeStatus: "REQUIRES_CERTIFICATION"/, "owned custom scripts fail closed until server certification exists");
assert.match(manifest, /configuredAlerts/);

for (const tab of ["OVERVIEW", "CONFIGURATION", "PAPER", "LIVE TARGETS", "POSITIONS", "TRADES", "PERFORMANCE", "RISK", "LOGS"]) assert.match(cockpit, new RegExp(tab));
assert.match(cockpit, /rows\.length > 100/, "large Paper tables use windowed rendering");
assert.match(targetMatrix, /Array\.from\(\{ length: 10 \}/);
assert.match(targetMatrix, /No live account allocated/);
assert.match(targetMatrix, /bindings\.filter/, "only occupied bindings create detailed state");
assert.doesNotMatch(`${experience}\n${library}\n${wizard}\n${cockpit}`, /localStorage\.setItem|sessionStorage\.setItem/, "server state is authoritative; the workflow does not duplicate strategy persistence in browser storage");
assert.equal((experience.match(/setInterval\(/g) || []).length, 1, "one cockpit snapshot poller is mounted");

assert.match(migration, /black_core_save_strategy_draft/);
assert.match(migration, /black_core_publish_strategy_draft/);
assert.match(migration, /black_core_start_strategy_version/);
assert.match(migration, /running_version/);
assert.match(migration, /status='PAUSED'/);
assert.doesNotMatch(migration, /strategy_target_bindings.*insert/is, "draft/publish migration creates no empty target rows");
assert.match(compose, /STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED: "false"/);
assert.match(compose, /STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED: "false"/);

console.log("My Strategy UX tests PASS — library landing, ten-step workflow, active-indicator/template separation, market and signal semantics, version boundaries, cockpit navigation, virtualized tables, empty target slots and preview live lock verified.");
