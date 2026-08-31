import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCertifiedSuperAtrSevenStepSource, ownedCustomIndicatorInstances } from "../src/modules/strategy-lab/my-strategy/state/indicatorManifest.ts";
import { formatExecutionTime, targetExecutionFailure } from "../src/modules/strategy-lab/my-strategy/cockpit/targetExecutionPresentation.ts";

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
const controlPanel = read("src/modules/strategy-lab/execution-desk/StrategyControlPanelDialog.tsx");
const theme = read("src/styles/theme.css");
const targetMatrix = read("src/modules/strategy-lab/my-strategy/cockpit/TargetSlotMatrix.tsx");
const targetCockpit = read("src/modules/strategy-lab/my-strategy/cockpit/TargetCockpit.tsx");
const automationTypes = read("src/modules/strategy-lab/automation/strategyAutomation.types.ts");
const reviewStep = read("src/modules/strategy-lab/my-strategy/wizard/ReviewStep.tsx");
const repository = read("server/strategy-automation/repository.js");
const service = read("server/strategy-automation/service.js");
const apiClient = read("src/modules/strategy-lab/automation/strategyAutomationApi.ts");
const migration = read("supabase/migrations/202608230001_my_strategy_draft_version_model.sql");
const archiveMigration = read("supabase/migrations/202608240001_strategy_automation_archive.sql");
const compose = read("infra/black-cloud/docker-compose.yml");

for (const label of ["Strategy and Market", "Signal Mapping", "Optional Trade Behavior", "Save Strategy"]) assert.match(draftStore, new RegExp(`"${label}"`));
assert.equal((draftStore.match(/^\s*"(?:Strategy and Market|Signal Mapping|Optional Trade Behavior|Save Strategy)",?$/gm) || []).length, 4);
assert.match(draftStore, /Strategy name must contain at least 2 characters/, "mandatory strategy name is validated at its own step");
assert.match(draftStore, /Select an existing Black Terminal indicator or one of your saved scripts/, "indicator selection is mandatory");
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
assert.match(library, /MODIFY STRATEGY/);
assert.match(library, /DELETE STRATEGY/);
assert.match(library, /aria-haspopup="menu"/);
assert.doesNotMatch(library, /BC-QALC|START FROM TEMPLATE|qalc-template-card/, "the library contains only user-created strategies");
assert.match(experience, /Modifying the saved draft/);
assert.match(experience, /DeleteStrategyDialog/);
assert.match(experience, /No broker order is placed, changed or cancelled/);
assert.match(experience, /DELETION_PAUSABLE_TARGET_STATES/);
assert.match(experience, /strategyAutomationApi\.targetAction\(authoritative\.strategy\.id, binding, "pause"\)/, "Delete explicitly pauses execution targets before archive");
assert.match(experience, /STRATEGY_DELETE_REQUIRES_SAFE_STATE/, "Delete waits for already-claimed execution commands to settle");
assert.match(experience, /Promise\.allSettled/, "all active target slots are quiesced before archive");
assert.match(apiClient, /mutation\(\{ expectedName: strategy\.name, expectedRevision: strategy\.draftRevision \|\| 0 \}, "DELETE"\)/);
assert.match(apiClient, /code: typeof payload\.code === "string"/, "Strategy API preserves authoritative error codes for lifecycle recovery");
assert.match(service, /req\.method === "DELETE"[\s\S]*archiveStrategy/);
assert.doesNotMatch(library, /StrategyDefinitionBuilder|NAME STRATEGY BEFORE SAVING/);
assert.equal((wizard.match(/step === \d/g) || []).length, 4, "simplified wizard renders only the active step");
assert.doesNotMatch(wizard, /IdentityStep|RiskStep|FiltersStep|ExitsStep|PaperStep|TargetsStep/, "strategy-native risk and all execution destinations are outside the creation wizard");
assert.match(indicator, /Nothing selected/);
assert.match(indicator, /none is selected automatically/);
assert.match(draftStore, /indicator: undefined/);
assert.match(draftStore, /runtimeKind: "external-signals"/, "new strategies start without a preselected signal engine");
assert.doesNotMatch(indicator, /START FROM A TEMPLATE|strategy-template-picker/, "the wizard has no default strategy templates");
assert.match(indicator, /Current chart:.*Runtime:/s, "strategy timeframe is explicitly independent of chart timeframe");
for (const command of ["USDT PERPETUAL FUTURES", "OPEN LONG", "OPEN SHORT", "CLOSE LONG", "CLOSE SHORT", "BUY ASSET", "SELL ASSET", "OWNED QUANTITY ONLY"]) assert.match(indicator, new RegExp(command));
assert.match(indicator, /selectStrategyMarket/, "market selection changes the saved execution contract rather than only its label");
assert.match(wizard, /Broker commands/, "the persistent wizard summary exposes the selected broker vocabulary");
assert.match(draftStore, /export function selectStrategyMarket/);
assert.match(draftStore, /signals: \{\}/, "changing market invalidates incompatible alert mappings");
assert.match(draftStore, /modelFunding: marketType === "FUTURES"/, "Spot never inherits perpetual funding");
assert.match(draftStore, /stopReversalEnabled: false/, "Spot cannot inherit Futures stop reversal");
assert.match(draftStore, /perpetualSignalReversalEnabled: false/, "Spot cannot inherit perpetual reversal");
assert.match(manifest, /source: "ACTIVE_CHART"/);
assert.match(manifest, /source: "CUSTOM"/);
assert.match(manifest, /source: active \? "ACTIVE_CHART" : "BUILT_IN"/);
assert.match(manifest, /readonly UserScript\[\]/, "owned Script Editor indicators and strategies are supplied by the authenticated script catalog");
assert.doesNotMatch(manifest, /localStorage|getItem\("bt_user_scripts"/, "the Strategy Lab manifest never reads the obsolete browser-global script key");
assert.match(page, /dbGetCurrentUserScripts/, "Strategy Lab loads the signed-in user's authoritative private script catalog");
assert.match(page, /bt_user_scripts:\$\{currentUser\.username\}/, "offline script lookup remains scoped to the signed-in username");
assert.match(manifest, /strategy\\\.exit/, "owned strategy exits are exposed to Signal Mapping");
assert.match(manifest, /strategy\\\.close/, "owned strategy close events are exposed to Signal Mapping");
assert.match(manifest, /runtimeStatus: "REQUIRES_CERTIFICATION"/, "owned custom scripts fail closed until server certification exists");
assert.match(manifest, /configuredAlerts/);

const [ownedSuperAtr] = ownedCustomIndicatorInstances([{
  id: "superatr-x",
  name: "SuperATRx (1D TF)",
  kind: "strategy",
  source: `
long_setup = close > open
short_setup = close < open
strategy.entry("SuperATR Long", strategy.long, when=long_setup)
strategy.entry("SuperATR Short", strategy.short, when=short_setup)
strategy.exit("Long TP1", "SuperATR Long", limit=close * 1.01)
strategy.exit("Short Stop", "SuperATR Short", stop=close * 1.01)
strategy.close("SuperATR Long", when=short_setup)
alertcondition(long_setup, "SuperATR Long Setup", "long")
alertcondition(short_setup, "SuperATR Short Setup", "short")
`,
  createdAt: 1,
  inputValues: { atrLength: 14, riskPercent: 1.5 },
}]);
assert.ok(ownedSuperAtr, "an authenticated saved strategy is selectable");
assert.equal(ownedSuperAtr.name, "SuperATRx (1D TF)", "the saved strategy name is preserved exactly");
assert.equal(ownedSuperAtr.instanceName, "SuperATRx (1D TF) — Owned Strategy");
assert.equal(ownedSuperAtr.settings.atrLength, 14, "saved input values reach Strategy Lab");
assert.equal(ownedSuperAtr.settings.riskPercent, 1.5);
assert.ok(Array.isArray(ownedSuperAtr.settings.__nativeInputs), "the script-native input manifest is pinned with the private strategy");
assert.ok(ownedSuperAtr.alerts.some((event) => event.semantic === "LONG_ENTRY"));
assert.ok(ownedSuperAtr.alerts.some((event) => event.semantic === "SHORT_ENTRY"));
assert.ok(ownedSuperAtr.alerts.some((event) => event.semantic === "LONG_EXIT"));
assert.ok(ownedSuperAtr.alerts.some((event) => event.semantic === "SHORT_EXIT"));
const certifiedSuperAtrSource = `
# SuperATR 7-Step Profit
short_period = input.int(3, "Short Period")
long_period = input.int(7, "Long Period")
momentum_period = input.int(7, "Momentum Period")
adaptive_atr = close
trend_strength = close
useMultiStepTP = input.bool(True, "Enable Multi-Step Take Profit")
strategy.entry("SuperATR Long", strategy.long, when=close > open)
strategy.entry("SuperATR Short", strategy.short, when=close < open)
${Array.from({ length: 7 }, (_, index) => `strategy.exit("TP${index + 1}", "SuperATR Long", limit=close + ${index + 1})`).join("\n")}
`;
assert.equal(isCertifiedSuperAtrSevenStepSource(certifiedSuperAtrSource), true, "the structurally pinned seven-step source is eligible for the native adapter");
assert.equal(isCertifiedSuperAtrSevenStepSource(certifiedSuperAtrSource.replace("adaptive_atr", "other_atr")), false, "lookalike scripts fail closed");

for (const tab of ["OVERVIEW", "EXECUTION DESK", "STRATEGY SETTINGS", "CONFIGURATION", "PAPER", "LIVE TARGETS", "POSITIONS", "TRADES", "PERFORMANCE", "RISK", "LOGS"]) assert.match(cockpit, new RegExp(tab));
assert.match(cockpit, /rows\.length > 100/, "large Paper tables use windowed rendering");
assert.match(targetMatrix, /Array\.from\(\{ length: 9 \}/);
assert.match(targetMatrix, /No execution destination assigned/);
assert.match(targetMatrix, /bindings\.filter/, "only occupied bindings create detailed state");
assert.match(targetMatrix, /EXECUTION FAILED/, "a failed target is unmistakable in the nine-slot matrix");
assert.match(targetCockpit, /target-execution-failure[^]*role="alert"/, "the target cockpit exposes broker execution failures as an operator alert");
assert.match(targetCockpit, /executionFailure\.errorMessage/, "the exact broker-preflight message remains visible");
assert.match(targetCockpit, /NO VENUE ORDER WAS SUBMITTED/, "pre-submission failures explicitly distinguish broker rejection from a venue order");
for (const field of ["latestExecutionStatus", "latestExecutionAction", "latestExecutionDirection", "latestExecutionAt", "latestExecutionErrorCode", "latestExecutionErrorMessage"]) assert.match(automationTypes, new RegExp(`${field}\\?:`), `${field} is optional target snapshot telemetry`);
assert.match(theme, /\.target-slot\.execution-failed/);
assert.match(theme, /\.target-execution-failure/);
const rejectedBeforeVenue = targetExecutionFailure({
  latestExecutionStatus: "FAILED",
  latestExecutionAction: "ENTRY",
  latestExecutionDirection: "SHORT",
  latestExecutionAt: "2026-08-30T23:45:00.000Z",
  latestExecutionErrorCode: "STRATEGY_QUANTITY_BELOW_VENUE_STEP",
  latestExecutionErrorMessage: "The risk-bounded strategy quantity is zero after applying the Bybit quantity step.",
} as Parameters<typeof targetExecutionFailure>[0]);
assert.equal(rejectedBeforeVenue?.errorMessage, "The risk-bounded strategy quantity is zero after applying the Bybit quantity step.", "broker-preflight messages are not rewritten");
assert.equal(rejectedBeforeVenue?.noVenueOrderSubmitted, true, "known venue-step preflight failures cannot be presented as submitted orders");
assert.equal(targetExecutionFailure({ latestExecutionStatus: "DEAD_LETTER" } as Parameters<typeof targetExecutionFailure>[0])?.status, "DEAD_LETTER", "retry-exhausted terminal commands remain visible as execution failures");
assert.equal(targetExecutionFailure({ latestExecutionStatus: "CANCELLED" } as Parameters<typeof targetExecutionFailure>[0])?.status, "CANCELLED", "dependency-cancelled protection commands remain visible as execution failures");
assert.equal(formatExecutionTime(1_788_133_500), "2026-08-30 23:45:00 UTC", "epoch seconds are normalized to an operator-readable UTC time");
assert.equal(targetExecutionFailure({ latestExecutionStatus: "SUCCEEDED" } as Parameters<typeof targetExecutionFailure>[0]), null, "successful execution does not leave a failure banner behind");
assert.match(cockpit, /NO EXECUTION DESTINATION ASSIGNED/);
assert.match(cockpit, /StrategyControlPanelDialog embedded/, "saved strategies expose an embedded dynamic Strategy Settings surface");
assert.match(cockpit, /__nativeInputs/, "custom script settings are reconstructed from their literal private manifest");
assert.match(controlPanel, /className="strategy-control-scroll" tabIndex=\{0\}/, "every strategy settings tab has a keyboard and wheel scroll surface");
assert.match(controlPanel, /key=\{tab\}/, "switching settings tabs resets the scroll viewport instead of preserving an invisible offset");
assert.match(controlPanel, /const initialSignature = JSON\.stringify\(initial\)/, "authoritative snapshot polling does not reset in-progress strategy settings edits by object identity");
assert.doesNotMatch(controlPanel, /setValue\(structuredClone\(initial\)\), \[initial\]/, "equivalent refreshed objects cannot make settings appear hard locked");
assert.match(controlPanel, /setValue\(structuredClone\(submitted\)\)/, "saving keeps the exact submitted settings while the refreshed VPS snapshot arrives");
assert.match(controlPanel, /authoritativeAvailableBalance/, "fixed-USDT sizing is constrained by synchronized broker funds");
assert.match(theme, /\.my-strategy-experience\s*\{[\s\S]*?height:\s*100%;[\s\S]*?overflow-y:\s*auto;/, "My Strategy owns a contained vertical viewport instead of being clipped by Strategy Lab");
assert.match(theme, /\.strategy-control-scroll\s*\{[^}]*overflow-y:\s*scroll;/, "Inputs, Properties, Style and Visibility expose a persistent vertical scrollbar");
assert.match(theme, /\.strategy-control-dialog\s*\{[^}]*background:\s*linear-gradient\([^;]*#010203/, "strategy settings use the Black Terminal black surface rather than the TradingView charcoal surface");
assert.match(theme, /\.strategy-control-dialog > nav button\.active::after[^}]*background:\s*#e31342/, "settings tabs use the Black Terminal phosphor-red active state");
assert.match(experience, /ENABLE FOR STRATEGY LAB/);
assert.match(experience, /BROKER CONNECTION/);
assert.match(experience, /INVESTMENT GROUP/);
assert.match(experience, /type="password"/);
assert.match(experience, /API Secret is never returned/);
assert.match(apiClient, /api\/strategy-connections/);
assert.match(experience, /eligibleTargets/);
assert.match(experience, /strategyAutomationApi\.addTarget/);
assert.doesNotMatch(experience.match(/const activateConfiguredStrategy[\s\S]*?const paperAction/)?.[0] || "", /addTarget|targetAction|eligibleTargets/, "saving a strategy cannot link or arm an execution destination");
assert.match(experience, /applyStrategyControlPanel\(base, draft\.paperPolicy, readStrategyControlPanel\(base, draft\.paperPolicy\)\)/, "SuperATR Script Editor inputs are normalized before immutable activation");
assert.match(experience, /type SettingsMutationStage = "SAVE_DRAFT" \| "UPDATE_GLOBAL_POLICY" \| "APPLY_DESTINATION"/, "strategy settings track all three durable mutation stages");
assert.match(experience, /setWorkspace\(null\);[\s\S]*setDraft\(null\);[\s\S]*strategyAutomationApi\.get\(strategyId\)/, "a partial settings save discards the stale revision before authoritative recovery");
assert.match(experience, /setWorkspace\(authoritative\);[\s\S]*setDraft\(hydrateDraft\(authoritative\)\)/, "authoritative recovery rehydrates both cockpit and draft state");
assert.match(experience, /PARTIAL SAVE RECOVERED[\s\S]*retry is safe/, "successful recovery gives an explicit retry-safe operator message");
assert.match(experience, /PARTIAL SAVE REQUIRES RELOAD[\s\S]*do not repeat Save from the old form/, "failed recovery closes stale settings and requires a clean reopen");
assert.match(experience, /passed the replacement-policy execution preflight and remains armed/, "the active cockpit explicitly confirms that a validated live policy save did not disarm its target");
assert.match(experience, /Its lifecycle state was not changed/, "non-live policy saves explicitly preserve their current target state");
assert.match(draftStore, /perpetualSignalReversalEnabled: false/);
assert.match(draftStore, /stopReversalEnabled: false/);
assert.match(reviewStep, /Save strategy/);
assert.match(reviewStep, /No broker or Investment Group is connected by this wizard/);
assert.doesNotMatch(reviewStep, /SAVE DRAFT ONLY|onSaveDraft|onActivate/, "the final review cannot route an obvious Save action into a draft-only dead end");
assert.match(wizard, /SAVE STRATEGY & OPEN COCKPIT/, "the final wizard page has one explicit completion action");
assert.match(wizard, /step < wizardSteps\.length - 1 \? <button[^>]*onClick=\{props\.onSaveDraft\}/, "draft-only persistence is available before review without competing with final activation");
assert.doesNotMatch(reviewStep, /PUBLISH VERSION|Review and publish/i, "private strategy activation is not described as public publishing");
assert.doesNotMatch(`${experience}\n${library}\n${wizard}\n${cockpit}`, /localStorage\.setItem|sessionStorage\.setItem/, "server state is authoritative; the workflow does not duplicate strategy persistence in browser storage");
assert.equal((experience.match(/setInterval\(/g) || []).length, 1, "one cockpit snapshot poller is mounted");
assert.match(repository, /strategy_paper_accounts"\)\.select\("id,strategy_id,strategy_version,/, "strategy library retains the canonical Paper account identity");
assert.match(repository, /strategy_automation_trades"\)\.select\("strategy_id,paper_account_id"\)/, "trade summaries use columns that exist in the execution ledger");
assert.match(repository, /paper_account_id === paper\.id/, "trade counts are scoped to the selected published\/running Paper version");
assert.doesNotMatch(repository, /strategy_automation_trades"\)\.select\("strategy_id,strategy_version"\)/, "strategy trades do not query the nonexistent strategy_version column");

assert.match(migration, /black_core_save_strategy_draft/);
assert.match(migration, /black_core_publish_strategy_draft/);
assert.match(migration, /black_core_start_strategy_version/);
assert.match(migration, /running_version/);
assert.match(migration, /status='PAUSED'/);
assert.doesNotMatch(migration, /strategy_target_bindings.*insert/is, "draft/publish migration creates no empty target rows");
assert.match(archiveMigration, /black_core_archive_strategy/);
assert.match(archiveMigration, /status in \('LIVE','DISCONNECTING'\)/, "active broker targets fail closed instead of being silently detached");
assert.match(archiveMigration, /status in \('QUEUED','PROCESSING','RETRY','SUBMISSION_UNKNOWN','RECONCILING'\)/, "pending broker commands must settle before deletion");
assert.match(archiveMigration, /brokerOrderMutation',false/, "delete audit explicitly records that no broker order mutation occurred");
assert.doesNotMatch(archiveMigration, /delete from public\./i, "user-facing delete retains immutable strategy history");
assert.match(compose, /STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true"/);
assert.match(compose, /STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED: "true"/);
assert.match(compose, /STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED: "true"/);
assert.match(compose, /STRATEGY_AUTOMATION_GROUP_EXECUTION_ENABLED: "true"/);

console.log("My Strategy UX tests PASS — four-step creation, script-native settings, isolated execution desk, nine post-save destinations and versioned runtime controls verified.");
