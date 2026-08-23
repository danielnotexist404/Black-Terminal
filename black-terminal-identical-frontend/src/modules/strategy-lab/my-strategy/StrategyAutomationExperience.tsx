import { AlertTriangle, LockKeyhole, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EligibleBrokerTarget,
  EligibleGroupTarget,
  StrategyAutomationDefinition,
  StrategyCapitalPolicy,
  StrategySummary,
  StrategyWorkspace,
} from "../automation/strategyAutomation.types";
import { strategyAutomationApi } from "../automation/strategyAutomationApi";
import type { StrategyIndicatorInstance } from "./state/indicatorManifest";
import { createWizardDraft, defaultWizardPaperPolicy, validateWizardStep, withWorkflowDefaults, type StrategyWizardDraft } from "./state/strategyDraftStore";
import { StrategyCockpitPage } from "./pages/StrategyCockpitPage";
import { StrategyLibraryPage } from "./pages/StrategyLibraryPage";
import { StrategyWizardPage } from "./pages/StrategyWizardPage";
import { activateBlackCloudConnectionViaApi, connectBybitDemoAccountViaApi, fetchBlackCloudStatusViaApi } from "../../../portfolio/portfolioApiClient";
import { QalcExperience } from "../qalc/QalcExperience";

type View = "library" | "wizard" | "cockpit" | "qalc";
type Props = {
  definition: StrategyAutomationDefinition;
  chartTimeframe: string;
  indicators: StrategyIndicatorInstance[];
  templates: StrategyIndicatorInstance[];
  onDefinitionChange: (definition: StrategyAutomationDefinition) => void;
  onOpenBacktest: (strategy: StrategySummary) => void;
};

export function StrategyAutomationExperience({ definition, chartTimeframe, indicators, templates, onDefinitionChange, onOpenBacktest }: Props) {
  const fixtureMode = typeof window !== "undefined" && window.location.hostname === "127.0.0.1" && new URLSearchParams(window.location.search).get("uiPreview") === "1"
    ? new URLSearchParams(window.location.search).get("strategyLabFixture")
    : null;
  const [view, setView] = useState<View>("library");
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [workspace, setWorkspace] = useState<StrategyWorkspace | null>(null);
  const [draft, setDraft] = useState<StrategyWizardDraft | null>(null);
  const [paperData, setPaperData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string>();
  const [addSlot, setAddSlot] = useState<number | null>(null);
  const [eligible, setEligible] = useState<{ brokerAccounts: EligibleBrokerTarget[]; groups: EligibleGroupTarget[] } | null>(null);
  const [demoConnection, setDemoConnection] = useState<{ id: string; label: string; state: string } | null>(null);
  const generation = useRef(0);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const { strategies: rows } = await strategyAutomationApi.list(signal);
    if (!signal?.aborted) setStrategies(rows);
    return rows;
  }, []);

  const loadWorkspace = useCallback(async (strategyId: string, signal?: AbortSignal) => {
    const current = ++generation.current;
    const next = await strategyAutomationApi.get(strategyId, signal);
    if (signal?.aborted || current !== generation.current) return null;
    setWorkspace(next);
    setPaperData(null);
    if (next.strategy.publishedVersion) {
      strategyAutomationApi.paperData(strategyId, signal).then((data) => {
        if (!signal?.aborted && current === generation.current) setPaperData(data);
      }).catch(() => { if (!signal?.aborted) setPaperData(null); });
    }
    return next;
  }, []);

  useEffect(() => {
    if (fixtureMode) {
      const next = fixtureWorkspace(definition, templates[0] || indicators[0]);
      setStrategies(fixtureStrategies(next));
      setLoading(false);
      if (fixtureMode === "wizard") { setWorkspace(next); setDraft(hydrateDraft(next)); setView("wizard"); }
      if (fixtureMode === "cockpit") { setWorkspace(next); setPaperData(fixturePaperData(next)); setView("cockpit"); }
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    loadList(controller.signal).catch((error) => !controller.signal.aborted && setMessage(errorMessage(error, "Strategy library is unavailable."))).finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [definition, fixtureMode, indicators, loadList, templates]);

  useEffect(() => {
    if (fixtureMode || view !== "cockpit" || !workspace?.strategy.id) return;
    let inFlight = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const [snapshot, nextPaperData] = await Promise.all([
          strategyAutomationApi.snapshot(workspace.strategy.id, controller.signal),
          strategyAutomationApi.paperData(workspace.strategy.id, controller.signal),
        ]);
        if (!controller.signal.aborted) {
          setWorkspace((current) => current ? { ...current, paper: snapshot.paper, snapshots: snapshot.targets, runtime: snapshot.runtime } : current);
          setPaperData(nextPaperData);
        }
      } catch { /* A transient snapshot failure must preserve last-known authoritative state. */ }
      finally { inFlight = false; }
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [fixtureMode, view, workspace?.strategy.id]);

  const newStrategy = () => {
    setWorkspace(null);
    setDraft(createWizardDraft(definition));
    setDirty(false);
    setMessage("Choose an active chart indicator or start from a separate Black Core template.");
    setDemoConnection(null);
    setView("wizard");
  };

  const openStrategy = async (strategyId: string) => {
    setBusy(true); setMessage("Loading strategy state from the VPS…");
    try {
      const next = await loadWorkspace(strategyId);
      if (!next) return;
      if (!next.strategy.publishedVersion) {
        setDraft(hydrateDraft(next)); setDirty(false); setView("wizard");
        setMessage("Draft restored from the VPS. No published runtime was changed.");
      } else {
        setView("cockpit"); setMessage("Strategy cockpit restored from authoritative VPS state.");
      }
      const demoBinding = next.bindings.find((binding) => binding.targetType === "BROKER_ACCOUNT");
      setDemoConnection(demoBinding?.connectionId ? { id: demoBinding.connectionId, label: demoBinding.targetLabel || "Bybit Demo", state: demoBinding.status } : null);
    } catch (error) { setMessage(errorMessage(error, "Strategy could not be opened.")); }
    finally { setBusy(false); }
  };

  const editStrategy = () => {
    if (!workspace) return;
    setDraft(hydrateDraft(workspace)); setDirty(false); setView("wizard");
    setMessage(`Editing current draft. Running V${workspace.strategy.runningVersion || "—"} remains unchanged.`);
  };

  const persistDraft = async (): Promise<StrategyWorkspace | null> => {
    if (!draft || busy) return workspace;
    const identityIssues = validateWizardStep(draft, 0);
    if (identityIssues.length) { setMessage(identityIssues[0]); return null; }
    setBusy(true);
    try {
      const definitionWithPolicy = persistedDefinition(draft);
      const next = draft.strategyId
        ? await strategyAutomationApi.saveDraft(draft.strategyId, draft.name.trim(), definitionWithPolicy, draft.draftRevision)
        : await strategyAutomationApi.createDraft(draft.name.trim(), definitionWithPolicy);
      setWorkspace(next);
      setDraft(hydrateDraft(next));
      setDirty(false);
      onDefinitionChange(definitionWithPolicy);
      await loadList();
      setMessage(`Draft saved ${new Date().toLocaleTimeString()}. Published and running versions were not changed.`);
      return next;
    } catch (error) { setMessage(errorMessage(error, "Draft save failed.")); return null; }
    finally { setBusy(false); }
  };

  const publish = async () => {
    if (!draft) return;
    const issues = validateWizardStep(draft, 9);
    if (issues.length) { setMessage(issues.join(" ")); return; }
    const saved = dirty || !draft.strategyId ? await persistDraft() : workspace;
    if (!saved) return;
    setBusy(true);
    try {
      const next = await strategyAutomationApi.publishDraft(saved.strategy.id, saved.strategy.draftRevision || 0);
      setWorkspace(next); setDraft(hydrateDraft(next)); setDirty(false); await loadList();
      setMessage(`Published immutable V${next.strategy.publishedVersion}. The running version remains V${next.strategy.runningVersion || "—"}.`);
    } catch (error) { setMessage(errorMessage(error, "Publish failed.")); }
    finally { setBusy(false); }
  };

  const startPublished = async () => {
    const source = workspace;
    const version = source?.strategy.publishedVersion;
    if (!source || !version) { setMessage("Publish a certified version before starting Paper Trading."); return; }
    setBusy(true);
    try {
      const next = await strategyAutomationApi.startVersion(source.strategy.id, version);
      setWorkspace(next); setDraft(hydrateDraft(next)); await loadList(); setView("cockpit");
      setMessage(`Paper Trading explicitly started with published V${version}. Live execution remains locked.`);
    } catch (error) { setMessage(errorMessage(error, "Paper runtime could not start.")); }
    finally { setBusy(false); }
  };

  const connectDemo = async (credentials: { accountName: string; apiKey: string; apiSecret: string }) => {
    if (busy || !draft) return;
    setBusy(true);
    setMessage("Verifying the Bybit Demo Trading account and creating its encrypted Black Cloud delegation…");
    try {
      const account = await connectBybitDemoAccountViaApi(credentials);
      if (!account) throw new Error("An authenticated session is required to connect Bybit Demo Trading.");
      const activation = await activateBlackCloudConnectionViaApi(account.id, {
        allowStrategyExecution: true,
        allowCopyTrading: false,
        allowInvestmentGroupExecution: false,
        maxLeverage: draft.paperPolicy.maximumLeverage,
        maxDailyLoss: draft.paperPolicy.maximumDailyLoss,
        allowedSymbols: [draft.definition.symbol],
        preserveProtectiveOrders: true
      });
      if (!activation?.connection?.id) throw new Error("Black Cloud did not return a demo connection identity.");
      setDemoConnection({ id: activation.connection.id, label: credentials.accountName, state: "SYNCING" });
      setMessage("Bybit Demo credentials verified. Black Cloud is authenticating the private stream and reconciling the simulated account.");
    } catch (error) {
      setMessage(errorMessage(error, "Bybit Demo connection failed."));
    } finally {
      setBusy(false);
    }
  };

  const refreshDemo = async () => {
    if (!demoConnection || busy) return;
    setBusy(true);
    try {
      const status = await fetchBlackCloudStatusViaApi();
      const row = status?.connections?.find((connection) => connection.id === demoConnection.id);
      const state = row?.execution_readiness === "READY" ? "READY" : row?.synchronization_state || row?.health_status || "SYNCING";
      setDemoConnection((current) => current ? { ...current, state } : current);
      setMessage(state === "READY" ? "Bybit Demo is synchronized and ready for activation." : `Bybit Demo is ${state}. Activation remains fail-closed until reconciliation completes.`);
    } catch (error) { setMessage(errorMessage(error, "Bybit Demo readiness is unavailable.")); }
    finally { setBusy(false); }
  };

  const activateDemoStrategy = async () => {
    if (!draft || !demoConnection || busy) return;
    const issues = validateWizardStep(draft, 9);
    if (issues.length) { setMessage(issues.join(" ")); return; }
    setBusy(true);
    setMessage("Saving the private configuration and preparing Bybit Demo activation…");
    try {
      const definitionWithPolicy = persistedDefinition(draft);
      let next = draft.strategyId
        ? await strategyAutomationApi.saveDraft(draft.strategyId, draft.name.trim(), definitionWithPolicy, draft.draftRevision)
        : await strategyAutomationApi.createDraft(draft.name.trim(), definitionWithPolicy);
      onDefinitionChange(definitionWithPolicy);
      if (!next.strategy.publishedVersion || next.strategy.hasDraftChanges) {
        next = await strategyAutomationApi.publishDraft(next.strategy.id, next.strategy.draftRevision || 0);
      }
      const version = next.strategy.publishedVersion;
      if (!version) throw new Error("The immutable strategy configuration was not created.");
      if (next.strategy.runningVersion !== version) next = await strategyAutomationApi.startVersion(next.strategy.id, version);

      let binding = next.bindings.find((item) => item.connectionId === demoConnection.id && item.strategyVersion === version && item.status !== "DISCONNECTED");
      if (!binding) {
        let candidate: EligibleBrokerTarget | undefined;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const targets = await strategyAutomationApi.eligibleTargets(next.strategy.id);
          candidate = targets.brokerAccounts.find((item) => item.targetId === demoConnection.id);
          if (candidate?.validation.eligible) break;
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        }
        if (!candidate) throw new Error("The verified Bybit Demo connection is not visible to Strategy Lab.");
        if (!candidate.validation.eligible) throw new Error(`Bybit Demo is not ready: ${candidate.validation.reasons.join(" ")}`);
        const added = await strategyAutomationApi.addTarget(next.strategy.id, 1, "BROKER_ACCOUNT", candidate.targetId, next.strategy.marketType, draft.paperPolicy);
        binding = added.binding;
      }
      if (binding.status === "READY") {
        const armed = await strategyAutomationApi.targetAction(next.strategy.id, binding, "arm");
        binding = armed.binding;
      }
      next = await strategyAutomationApi.get(next.strategy.id);
      setWorkspace(next);
      setDraft(hydrateDraft(next));
      setDirty(false);
      setDemoConnection({ id: demoConnection.id, label: demoConnection.label, state: binding.status });
      await loadList();
      setView("cockpit");
      setMessage(`Strategy V${version} is active on Bybit Demo Trading with simulated funds. Real-funds Mainnet remains locked.`);
    } catch (error) {
      setMessage(errorMessage(error, "Bybit Demo strategy activation failed."));
    } finally {
      setBusy(false);
    }
  };

  const paperAction = async (action: "start" | "pause" | "top-up" | "reset", body: Record<string, unknown> = {}) => {
    if (!workspace?.paper) { setMessage("This published version has no Paper target."); return; }
    setBusy(true);
    try {
      const { paper } = await strategyAutomationApi.paperAction(workspace.strategy.id, action, workspace.paper.rowVersion, body);
      setWorkspace((current) => current ? { ...current, paper } : current);
      await loadList();
      setMessage(action === "pause" ? "Paper Trading paused. No live target was changed." : `Paper action ${action.replace("-", " ")} completed.`);
    } catch (error) { setMessage(errorMessage(error, "Paper action failed.")); }
    finally { setBusy(false); }
  };

  const refreshCockpit = async () => {
    if (!workspace) return;
    setBusy(true);
    try { await loadWorkspace(workspace.strategy.id); setMessage("Cockpit refreshed from the VPS."); }
    catch (error) { setMessage(errorMessage(error, "Refresh failed; last-known state is preserved.")); }
    finally { setBusy(false); }
  };

  const libraryPaperAction = async (strategy: StrategySummary, action: "start" | "pause") => {
    setBusy(true);
    try {
      let next = await loadWorkspace(strategy.id);
      if (!next) return;
      if (!next.strategy.runningVersion) {
        if (action === "pause" || !next.strategy.publishedVersion) {
          setMessage("Publish and explicitly start a version before controlling Paper Trading.");
          return;
        }
        next = await strategyAutomationApi.startVersion(next.strategy.id, next.strategy.publishedVersion);
        setWorkspace(next);
      } else if (next.paper) {
        const result = await strategyAutomationApi.paperAction(next.strategy.id, action, next.paper.rowVersion);
        next = { ...next, paper: result.paper };
        setWorkspace(next);
      }
      await loadList();
      setMessage(action === "start" ? "Paper Trading started. Live execution remains locked." : "Paper Trading paused.");
    } catch (error) { setMessage(errorMessage(error, "Paper action failed.")); }
    finally { setBusy(false); }
  };

  const openTargetPicker = async (slot: number) => {
    if (!workspace) { setMessage("Save the strategy configuration before adding a Bybit Demo target."); return; }
    setBusy(true); setAddSlot(slot); setEligible(null);
    try { const result = await strategyAutomationApi.eligibleTargets(workspace.strategy.id); setEligible({ brokerAccounts: result.brokerAccounts, groups: result.groups }); }
    catch (error) { setMessage(errorMessage(error, "Eligible targets are unavailable.")); setAddSlot(null); }
    finally { setBusy(false); }
  };

  const addTarget = async (target: EligibleBrokerTarget | EligibleGroupTarget) => {
    if (!workspace || addSlot === null || !target.validation.eligible) return;
    setBusy(true);
    try {
      await strategyAutomationApi.addTarget(workspace.strategy.id, addSlot, target.targetType, target.targetId, workspace.strategy.marketType, workspace.paper?.capitalPolicy || workspace.strategy.globalCapitalPolicy);
      await loadWorkspace(workspace.strategy.id); setAddSlot(null); setEligible(null);
      setMessage("Bybit Demo target prepared. Review its risk policy, then activate demo execution.");
    } catch (error) { setMessage(errorMessage(error, "Target could not be prepared.")); }
    finally { setBusy(false); }
  };

  const targetAction = async (bindingId: string, action: "arm" | "pause" | "resume") => {
    if (!workspace) return;
    const binding = workspace.bindings.find((item) => item.id === bindingId);
    if (!binding) return;
    setBusy(true);
    try { await strategyAutomationApi.targetAction(workspace.strategy.id, binding, action); await loadWorkspace(workspace.strategy.id); setMessage(action === "arm" ? "Bybit Demo strategy execution activated." : action === "pause" ? "Demo target paused." : "Demo target revalidated and resumed."); }
    catch (error) { setMessage(errorMessage(error, "Target action failed.")); }
    finally { setBusy(false); }
  };

  const disconnectTarget = async (bindingId: string) => {
    if (!workspace) return;
    const binding = workspace.bindings.find((item) => item.id === bindingId);
    if (!binding) return;
    setBusy(true);
    try { await strategyAutomationApi.disconnectTarget(workspace.strategy.id, binding, "DETACH_MANUAL"); await loadWorkspace(workspace.strategy.id); setMessage(`Target ${String(binding.slotIndex).padStart(2, "0")} disconnected. Its slot is empty; audit history is retained.`); }
    catch (error) { setMessage(errorMessage(error, "Target disconnect failed.")); }
    finally { setBusy(false); }
  };

  return <div className="my-strategy-experience">
    {view === "library" ? <StrategyLibraryPage strategies={strategies} loading={loading} message={message} onCreate={newStrategy} onOpen={(id) => void openStrategy(id)} onBacktest={onOpenBacktest} onPaperAction={(strategy, action) => void libraryPaperAction(strategy, action)} onOpenQalc={() => setView("qalc")} /> : null}
    {view === "qalc" ? <QalcExperience onBack={() => setView("library")} /> : null}
    {view === "wizard" && draft ? <StrategyWizardPage draft={draft} chartTimeframe={chartTimeframe} indicators={indicators} templates={templates} bindings={workspace?.bindings || []} publishedName={workspace?.strategy.name} publishedDefinition={workspace?.strategy.definition} saving={busy} message={message || (dirty ? "Draft changes have not been saved." : undefined)} demoConnection={demoConnection} onChange={(next) => { setDraft(next); setDirty(true); }} onSaveDraft={() => void persistDraft()} onConnectDemo={connectDemo} onRefreshDemo={refreshDemo} onActivate={() => void activateDemoStrategy()} onCancel={() => { setView(workspace?.strategy.publishedVersion ? "cockpit" : "library"); setMessage(undefined); }} /> : null}
    {view === "cockpit" && workspace ? <StrategyCockpitPage workspace={workspace} paperData={paperData} busy={busy} message={message} onEdit={editStrategy} onRefresh={() => void refreshCockpit()} onPaperAction={(action, body) => void paperAction(action, body)} onAddTarget={(slot) => void openTargetPicker(slot)} onTargetAction={(bindingId, action) => void targetAction(bindingId, action)} onDisconnectTarget={(bindingId) => void disconnectTarget(bindingId)} /> : null}
    {addSlot !== null ? <TargetPicker slot={addSlot} eligible={eligible} busy={busy} onClose={() => { setAddSlot(null); setEligible(null); }} onSelect={(target) => void addTarget(target)} /> : null}
  </div>;
}

function persistedDefinition(draft: StrategyWizardDraft): StrategyAutomationDefinition {
  return { ...draft.definition, metadata: { ...draft.definition.metadata, description: draft.description, tags: draft.tags }, paper: { ...draft.definition.paper, capitalPolicy: draft.paperPolicy } };
}

function hydrateDraft(workspace: StrategyWorkspace): StrategyWizardDraft {
  const definition = withWorkflowDefaults(workspace.strategy.draftDefinition || workspace.strategy.definition);
  const embeddedPolicy = definition.paper?.capitalPolicy;
  return {
    strategyId: workspace.strategy.id,
    name: workspace.strategy.draftName || workspace.strategy.name,
    description: definition.metadata?.description || "",
    tags: definition.metadata?.tags || [],
    definition,
    paperPolicy: isCapitalPolicy(embeddedPolicy) ? embeddedPolicy : workspace.paper?.capitalPolicy || workspace.strategy.globalCapitalPolicy || defaultWizardPaperPolicy(definition.marketType),
    draftRevision: workspace.strategy.draftRevision || 0,
    draftBaseVersion: workspace.strategy.draftBaseVersion,
    publishedVersion: workspace.strategy.publishedVersion,
    runningVersion: workspace.strategy.runningVersion,
    lastSavedAt: workspace.strategy.draftUpdatedAt || undefined,
  };
}

function isCapitalPolicy(value: unknown): value is StrategyCapitalPolicy { return Boolean(value && typeof value === "object" && "strategyAllocationMode" in value && "tradeAmountMode" in value); }

function TargetPicker({ slot, eligible, busy, onClose, onSelect }: { slot: number; eligible: { brokerAccounts: EligibleBrokerTarget[]; groups: EligibleGroupTarget[] } | null; busy: boolean; onClose: () => void; onSelect: (target: EligibleBrokerTarget | EligibleGroupTarget) => void }) {
  const targets = eligible?.brokerAccounts || [];
  return <div className="strategy-modal-backdrop" role="presentation"><section className="strategy-target-picker" role="dialog" aria-modal="true" aria-label={`Add target ${slot}`}><header><div><span>TARGET {String(slot).padStart(2, "0")}</span><h2>Add Bybit Demo account</h2></div><button type="button" aria-label="Close target picker" onClick={onClose}><X size={16} /></button></header><div className="target-picker-warning"><LockKeyhole size={13} /><span>Only synchronized Bybit Demo Trading accounts are eligible. Real-funds Mainnet accounts are rejected.</span></div>{busy && !eligible ? <div className="cockpit-empty-state compact">Checking ownership, private-stream health and reconciliation…</div> : targets.length ? <div className="eligible-target-list">{targets.map((target) => <button type="button" key={`${target.targetType}:${target.targetId}`} disabled={!target.validation.eligible || busy} onClick={() => onSelect(target)}><span>{target.targetType === "BROKER_ACCOUNT" ? `${target.provider} DEMO` : "INVESTMENT GROUP"}</span><strong>{target.label}</strong><em>{target.validation.eligible ? "Eligible for simulated-funds execution" : target.validation.reasons.join(" · ")}</em></button>)}</div> : <div className="cockpit-empty-state"><AlertTriangle size={19} /><strong>No eligible Bybit Demo target</strong><span>Connect a trade-enabled Bybit Demo API key and wait for Black Cloud reconciliation.</span></div>}</section></div>;
}

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

function fixtureWorkspace(base: StrategyAutomationDefinition, indicator?: StrategyIndicatorInstance): StrategyWorkspace {
  const now = new Date().toISOString();
  const bound = indicator ? { ...withWorkflowDefaults(base), runtimeKind: indicator.runtimeKind, indicator, settings: { ...base.settings, ...indicator.settings }, signals: { longEntry: indicator.alerts[0]?.id || "long-entry", shortEntry: indicator.alerts[1]?.id || indicator.alerts[0]?.id || "short-entry" }, paper: { demoEquity: 25_000, capitalPolicy: defaultWizardPaperPolicy("FUTURES") } } : withWorkflowDefaults(base);
  const policy = defaultWizardPaperPolicy(bound.marketType);
  return {
    strategy: { id: "preview-strategy-1", name: "Hidden Distribution Swing", runtimeKind: bound.runtimeKind, symbol: bound.symbol || "BTCUSDT", timeframe: "4h", marketType: bound.marketType, exchange: "bybit", currentVersion: 3, publishedVersion: 3, runningVersion: 3, draftRevision: 7, draftUpdatedAt: now, hasDraftChanges: false, status: "PAPER_ACTIVE", createdAt: now, updatedAt: now, definition: bound, draftDefinition: bound, draftName: "Hidden Distribution Swing", draftBaseVersion: 3, globalCapitalPolicy: policy },
    versions: [{ version: 3, name: "Hidden Distribution Swing", definition: bound, status: "PUBLISHED", createdAt: now }],
    paper: { id: "paper-preview-1", strategyId: "preview-strategy-1", strategyVersion: 3, marketType: bound.marketType, status: "ACTIVE", demoEquity: 25_000, availableBalance: 23_840, usedStrategyCapital: 1_160, realizedPnl: 1_284.42, unrealizedPnl: 164.18, fees: 82.4, funding: 11.6, capitalPolicyVersion: 2, rowVersion: 9, capitalPolicy: policy, maximumDrawdownPercent: 4.81, preview: { allocatedStrategyCapital: 25_000, entryCapital: 2_500, requestedLeverage: 1, effectiveLeverage: 1, estimatedNotional: 2_500, estimatedMargin: 2_500, remainingReserve: 22_500 }, updatedAt: now },
    bindings: [], snapshots: [], runtime: { state: "RUNNING", lastClosedCandleAt: now, lastSignalAt: now, lastHeartbeatAt: now },
    audit: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, event_type: index % 3 === 0 ? "SIGNAL_ACCEPTED" : index % 3 === 1 ? "PAPER_FILL" : "WORKER_CHECKPOINT", severity: "INFO", message: index % 3 === 0 ? "Confirmed-bar signal accepted by Paper risk policy." : index % 3 === 1 ? "Paper fill recorded with modeled fees and slippage." : "Black Cloud worker state checkpoint completed.", safe_metadata: {}, created_at: new Date(Date.now() - index * 90_000).toISOString() })),
  };
}

function fixtureStrategies(workspace: StrategyWorkspace): StrategySummary[] {
  const primary = workspace.strategy;
  return [{ ...primary, indicatorName: primary.definition.indicator?.name, paperEquity: 26_354.6, paperPnl: 1_354.6, paperDrawdown: 4.81, paperTrades: 86, connectedTargets: 0, runtimeState: "RUNNING", lastSignalAt: primary.updatedAt, lastHeartbeatAt: primary.updatedAt }, { ...primary, id: "preview-strategy-2", name: "BTC Momentum Confirmation", symbol: "ETHUSDT", timeframe: "1h", currentVersion: 2, publishedVersion: 2, runningVersion: null, status: "PAPER_PAUSED", paperEquity: 10_882.15, paperPnl: 882.15, paperDrawdown: 7.2, paperTrades: 41, connectedTargets: 0, runtimeState: "PAUSED", lastSignalAt: undefined }];
}

function fixturePaperData(workspace: StrategyWorkspace): Record<string, unknown> {
  const now = Date.now();
  return { positions: [{ id: "position-1", symbol: workspace.strategy.symbol, direction: "LONG", quantity: 0.12, average_price: 72_140.2, current_price: 73_518.4, leverage: 1, stop_loss: 69_800, take_profit: 78_500, unrealized_pnl: 164.18, protection_status: "PROTECTED" }], orders: [], trades: Array.from({ length: 14 }, (_, index) => ({ id: `trade-${index}`, symbol: workspace.strategy.symbol, direction: index % 2 ? "SHORT" : "LONG", opened_at: new Date(now - (index + 2) * 3_600_000).toISOString(), closed_at: new Date(now - (index + 1) * 3_600_000).toISOString(), entry_price: 70_000 + index * 120, exit_price: 70_140 + index * 125, quantity: .1, gross_pnl: 80 + index * 3, fees: 4.2, funding: .4, net_pnl: 75.4 + index * 3, exit_reason: index % 3 ? "TAKE PROFIT" : "RISK EXIT" })), executions: [], analytics: { netPnl: 1_354.6, currentDrawdownPercent: 1.2, maxDrawdownPercent: 4.81, winRate: 63.95, profitFactor: 1.82, sharpe: 1.44, sortino: 2.08 } };
}
