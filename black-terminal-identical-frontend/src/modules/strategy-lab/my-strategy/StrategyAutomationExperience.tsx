import { AlertTriangle, Building2, CloudCog, KeyRound, Link2, LockKeyhole, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EligibleBrokerTarget,
  EligibleGroupTarget,
  StrategyAutomationDefinition,
  StrategyBrokerConnection,
  StrategyCapitalPolicy,
  StrategyControlPanel,
  StrategySummary,
  StrategyTargetBinding,
  StrategyWorkspace,
} from "../automation/strategyAutomation.types";
import { strategyAutomationApi, strategyConnectionApi } from "../automation/strategyAutomationApi";
import type { StrategyIndicatorInstance } from "./state/indicatorManifest";
import { createWizardDraft, defaultWizardPaperPolicy, validateWizardStep, withWorkflowDefaults, type StrategyWizardDraft } from "./state/strategyDraftStore";
import { StrategyCockpitPage } from "./pages/StrategyCockpitPage";
import { StrategyLibraryPage } from "./pages/StrategyLibraryPage";
import { StrategyWizardPage } from "./pages/StrategyWizardPage";
import { QalcExperience } from "../qalc/QalcExperience";
import { consumeQalcStrategyHandoffIntent } from "../../qalc-indicator/config";
import { applySharedStrategyControlPanel, applyStrategyControlPanel, readStrategyControlPanel } from "../execution-desk/strategyControlPanelModel";
import { activateBlackCloudConnectionViaApi, listPersistedExchangeConnectionsViaApi, type PersistedExchangeConnection } from "../../../portfolio/portfolioApiClient";

type View = "library" | "wizard" | "cockpit" | "qalc";
type Props = {
  definition: StrategyAutomationDefinition;
  chartTimeframe: string;
  indicators: StrategyIndicatorInstance[];
  onDefinitionChange: (definition: StrategyAutomationDefinition) => void;
  onOpenBacktest: (workspace: StrategyWorkspace) => void;
};

export function StrategyAutomationExperience({ definition, chartTimeframe, indicators, onDefinitionChange, onOpenBacktest }: Props) {
  const fixtureMode = typeof window !== "undefined" && window.location.hostname === "127.0.0.1" && new URLSearchParams(window.location.search).get("uiPreview") === "1"
    ? new URLSearchParams(window.location.search).get("strategyLabFixture")
    : null;
  const [view, setView] = useState<View>(() => consumeQalcStrategyHandoffIntent() ? "qalc" : "library");
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [workspace, setWorkspace] = useState<StrategyWorkspace | null>(null);
  const [draft, setDraft] = useState<StrategyWizardDraft | null>(null);
  const [paperData, setPaperData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<StrategySummary | null>(null);
  const [addSlot, setAddSlot] = useState<number | null>(null);
  const [eligible, setEligible] = useState<{ brokerAccounts: EligibleBrokerTarget[]; groups: EligibleGroupTarget[] } | null>(null);
  const [brokerConnections, setBrokerConnections] = useState<StrategyBrokerConnection[]>([]);
  const [existingExchangeConnections, setExistingExchangeConnections] = useState<PersistedExchangeConnection[]>([]);
  const [editingBinding, setEditingBinding] = useState<StrategyTargetBinding | null>(null);
  const [wizardEligible, setWizardEligible] = useState<{ brokerAccounts: EligibleBrokerTarget[]; groups: EligibleGroupTarget[] } | null>(null);
  const [wizardTargetPickerMode, setWizardTargetPickerMode] = useState<"BROKER" | "GROUP" | null>(null);
  useEffect(() => {
    const openQalc = () => { consumeQalcStrategyHandoffIntent(); setView("qalc"); };
    window.addEventListener("bt:qalc-open-strategy-lab", openQalc);
    return () => window.removeEventListener("bt:qalc-open-strategy-lab", openQalc);
  }, []);
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

  const openBacktest = useCallback(async (strategy: StrategySummary) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const next = await strategyAutomationApi.get(strategy.id);
      onOpenBacktest(next);
    } catch (error) {
      setMessage(errorMessage(error, "The saved strategy could not be loaded for backtesting."));
    } finally {
      setBusy(false);
    }
  }, [onOpenBacktest]);

  useEffect(() => {
    if (fixtureMode) {
      const next = fixtureWorkspace(definition, indicators[0]);
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
  }, [definition, fixtureMode, indicators, loadList]);

  useEffect(() => {
    if (fixtureMode || view !== "cockpit" || !workspace?.strategy.id) return;
    let inFlight = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const [snapshotResult, paperResult] = await Promise.allSettled([
          strategyAutomationApi.snapshot(workspace.strategy.id, controller.signal),
          strategyAutomationApi.paperData(workspace.strategy.id, controller.signal),
        ]);
        if (!controller.signal.aborted && snapshotResult.status === "fulfilled") {
          const snapshot = snapshotResult.value;
          setWorkspace((current) => current ? { ...current, paper: snapshot.paper, snapshots: snapshot.targets, runtime: snapshot.runtime } : current);
        }
        if (!controller.signal.aborted && paperResult.status === "fulfilled") setPaperData(paperResult.value);
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
    setMessage("Choose an existing Black Terminal indicator with alert events, or one of your own saved scripts.");
    setWizardEligible(null);
    setView("wizard");
  };

  const openStrategy = async (strategyId: string) => {
    setBusy(true); setMessage("Loading strategy state from the VPS…");
    try {
      const next = await loadWorkspace(strategyId);
      if (!next) return;
      setDraft(hydrateDraft(next)); setDirty(false); setView("cockpit");
      setMessage(next.strategy.publishedVersion
        ? "Strategy cockpit restored from authoritative VPS state."
        : "Saved strategy restored. Its settings are available; Paper and live execution remain locked until runtime certification.");
    } catch (error) { setMessage(errorMessage(error, "Strategy could not be opened.")); }
    finally { setBusy(false); }
  };

  const editStrategy = () => {
    if (!workspace) return;
    setDraft(hydrateDraft(workspace)); setDirty(false); setView("wizard");
    setMessage(`Editing current draft. Running V${workspace.strategy.runningVersion || "—"} remains unchanged.`);
  };

  const modifyStrategy = async (strategyId: string) => {
    setBusy(true);
    setMessage("Loading the saved strategy configuration from the VPS…");
    try {
      const next = await loadWorkspace(strategyId);
      if (!next) return;
      setDraft(hydrateDraft(next));
      setDirty(false);
      setWizardEligible(null);
      setView("wizard");
      setMessage(`Modifying the saved draft. Published V${next.strategy.publishedVersion || "—"} and running V${next.strategy.runningVersion || "—"} remain unchanged until an explicit save and activation.`);
    } catch (error) { setMessage(errorMessage(error, "Strategy configuration could not be loaded.")); }
    finally { setBusy(false); }
  };

  const deleteStrategy = async () => {
    if (!pendingDelete || busy) return;
    const selected = pendingDelete;
    let pausedTargetCount = 0;
    setBusy(true);
    try {
      if (fixtureMode) {
        setStrategies((current) => current.filter((strategy) => strategy.id !== selected.id));
      } else {
        let authoritative = await strategyAutomationApi.get(selected.id);
        // Delete is an explicit request to retire the strategy, so quiesce every
        // target that can still admit new signals before asking the atomic archive
        // transaction to disconnect it. This never submits, changes or cancels a
        // broker order and never closes a broker position.
        for (let pass = 0; pass < 3; pass += 1) {
          const pausable = authoritative.bindings.filter((binding) => DELETION_PAUSABLE_TARGET_STATES.has(binding.status));
          if (!pausable.length) break;
          const results = await Promise.allSettled(
            pausable.map((binding) => strategyAutomationApi.targetAction(authoritative.strategy.id, binding, "pause")),
          );
          const nonConflictFailure = results.find((result) => result.status === "rejected" && strategyApiErrorCode(result.reason) !== "STRATEGY_TARGET_VERSION_CONFLICT");
          if (nonConflictFailure?.status === "rejected") throw nonConflictFailure.reason;
          pausedTargetCount += results.filter((result) => result.status === "fulfilled").length;
          authoritative = await strategyAutomationApi.get(selected.id);
        }

        // A command may already have been claimed immediately before the pause.
        // Preserve the fail-closed archive contract and briefly wait for that
        // authoritative command to settle instead of making the user manually
        // repeat Delete. A still-running command remains protected and visible.
        let archived = false;
        let lastSafeStateError: unknown;
        for (let attempt = 0; attempt < DELETE_SETTLEMENT_ATTEMPTS; attempt += 1) {
          try {
            await strategyAutomationApi.remove(authoritative.strategy);
            archived = true;
            break;
          } catch (error) {
            if (strategyApiErrorCode(error) !== "STRATEGY_DELETE_REQUIRES_SAFE_STATE") throw error;
            lastSafeStateError = error;
            await waitForDeleteSettlement(DELETE_SETTLEMENT_INTERVAL_MS);
            authoritative = await strategyAutomationApi.get(selected.id);
            const newlyActive = authoritative.bindings.filter((binding) => DELETION_PAUSABLE_TARGET_STATES.has(binding.status));
            for (const binding of newlyActive) {
              await strategyAutomationApi.targetAction(authoritative.strategy.id, binding, "pause");
              pausedTargetCount += 1;
            }
            if (newlyActive.length) authoritative = await strategyAutomationApi.get(selected.id);
          }
        }
        if (!archived) throw lastSafeStateError || new Error("Strategy deletion is waiting for an in-flight broker command to settle. Try Delete again shortly.");
        await loadList();
      }
      if (workspace?.strategy.id === selected.id) {
        setWorkspace(null);
        setDraft(null);
        setPaperData(null);
        setWizardEligible(null);
      }
      setPendingDelete(null);
      setView("library");
      setMessage(`“${selected.name}” was deleted from My Strategy.${pausedTargetCount ? ` ${pausedTargetCount} active execution target${pausedTargetCount === 1 ? " was" : "s were"} paused and disconnected.` : ""} Its runtime was stopped and immutable audit history was retained.`);
    } catch (error) { setPendingDelete(null); setMessage(errorMessage(error, "Strategy deletion failed.")); }
    finally { setBusy(false); }
  };

  const persistDraft = async (sourceDraft: StrategyWizardDraft | null = draft): Promise<StrategyWorkspace | null> => {
    if (!sourceDraft || busy) return workspace;
    const identityIssues = validateWizardStep(sourceDraft, 0);
    if (identityIssues.length) { setMessage(identityIssues[0]); return null; }
    setBusy(true);
    try {
      const definitionWithPolicy = persistedDefinition(sourceDraft);
      const next = sourceDraft.strategyId
        ? await strategyAutomationApi.saveDraft(sourceDraft.strategyId, sourceDraft.name.trim(), definitionWithPolicy, sourceDraft.draftRevision)
        : await strategyAutomationApi.createDraft(sourceDraft.name.trim(), definitionWithPolicy);
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
    const issues = validateWizardStep(draft, 3);
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

  const prepareWizardTargets = async (sourceDraft?: StrategyWizardDraft) => {
    const selectedDraft = sourceDraft || draft;
    if (!selectedDraft || busy) return;
    setMessage("Saving this execution destination and loading eligible targets…");
    let saved = workspace;
    if (sourceDraft || !selectedDraft.strategyId || dirty) saved = await persistDraft(selectedDraft);
    if (!saved) return;
    setBusy(true);
    try {
      const result = await strategyAutomationApi.eligibleTargets(saved.strategy.id);
      setWizardEligible({ brokerAccounts: result.brokerAccounts, groups: result.groups });
      setMessage("Execution destinations refreshed from authenticated Black Cloud ownership and readiness state.");
    } catch (error) { setMessage(errorMessage(error, "Execution destinations are unavailable.")); }
    finally { setBusy(false); }
  };

  const activateConfiguredStrategy = async () => {
    if (!draft || busy) return;
    const issues = validateWizardStep(draft, 3);
    if (issues.length) { setMessage(issues.join(" ")); return; }
    setBusy(true);
    setMessage("Saving the private strategy and preparing its isolated Strategy Lab cockpit…");
    try {
      const definitionWithPolicy = persistedDefinition(draft);
      let next = draft.strategyId
        ? await strategyAutomationApi.saveDraft(draft.strategyId, draft.name.trim(), definitionWithPolicy, draft.draftRevision)
        : await strategyAutomationApi.createDraft(draft.name.trim(), definitionWithPolicy);
      onDefinitionChange(definitionWithPolicy);
      const certified = definitionWithPolicy.indicator?.runtimeStatus === "CERTIFIED";
      if (certified && (!next.strategy.publishedVersion || next.strategy.hasDraftChanges)) {
        next = await strategyAutomationApi.publishDraft(next.strategy.id, next.strategy.draftRevision || 0);
      }
      const version = next.strategy.publishedVersion;
      if (certified && version && next.strategy.runningVersion !== version) next = await strategyAutomationApi.startVersion(next.strategy.id, version);
      const activationMessage = certified && version
        ? `Strategy V${version} is saved and active only in its isolated Paper account. Add brokers or Investment Groups from LIVE TARGETS when you are ready.`
        : "Strategy saved with its native settings. Paper and live arming remain locked until this script receives a certified VPS runtime.";
      next = await strategyAutomationApi.get(next.strategy.id);
      setWorkspace(next);
      setDraft(hydrateDraft(next));
      setDirty(false);
      await loadList();
      setView("cockpit");
      setMessage(activationMessage);
    } catch (error) {
      setMessage(errorMessage(error, "Strategy activation failed."));
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

  const openTargetPicker = async (slot: number, binding: StrategyTargetBinding | null = null) => {
    if (!workspace) { setMessage("Save the strategy configuration before adding an execution target."); return; }
    setBusy(true); setAddSlot(slot); setEditingBinding(binding); setEligible(null);
    try {
      const [result, connections, persisted] = await Promise.all([strategyAutomationApi.eligibleTargets(workspace.strategy.id), strategyConnectionApi.list(), listPersistedExchangeConnectionsViaApi()]);
      setEligible({ brokerAccounts: result.brokerAccounts, groups: result.groups });
      setBrokerConnections(connections.connections);
      setExistingExchangeConnections(persisted?.connections || []);
    }
    catch (error) { setMessage(errorMessage(error, "Eligible targets are unavailable.")); setAddSlot(null); }
    finally { setBusy(false); }
  };

  const openWizardTargetManager = async (targetType: "BROKER_ACCOUNT" | "INVESTMENT_GROUP", sourceDraft: StrategyWizardDraft) => {
    if (busy) return;
    let saved = workspace;
    if (!sourceDraft.strategyId || dirty) saved = await persistDraft(sourceDraft);
    if (!saved) return;
    setWizardTargetPickerMode(targetType === "BROKER_ACCOUNT" ? "BROKER" : "GROUP");
    setEligible(null);
    setBusy(true);
    try {
      const [result, connections, persisted] = await Promise.all([strategyAutomationApi.eligibleTargets(saved.strategy.id), strategyConnectionApi.list(), listPersistedExchangeConnectionsViaApi()]);
      const next = { brokerAccounts: result.brokerAccounts, groups: result.groups };
      setEligible(next);
      setWizardEligible(next);
      setBrokerConnections(connections.connections);
      setExistingExchangeConnections(persisted?.connections || []);
    } catch (error) {
      setWizardTargetPickerMode(null);
      setMessage(errorMessage(error, "Broker and Investment Group controls are unavailable."));
    } finally { setBusy(false); }
  };

  const refreshTargetPicker = async (sourceWorkspace: StrategyWorkspace | null = workspace) => {
    if (!sourceWorkspace) return null;
    const [result, connections, persisted] = await Promise.all([strategyAutomationApi.eligibleTargets(sourceWorkspace.strategy.id), strategyConnectionApi.list(), listPersistedExchangeConnectionsViaApi()]);
    const next = { brokerAccounts: result.brokerAccounts, groups: result.groups };
    setEligible(next); setBrokerConnections(connections.connections);
    setExistingExchangeConnections(persisted?.connections || []);
    if (wizardTargetPickerMode) setWizardEligible(next);
    return next;
  };

  const selectWizardTarget = (target: EligibleBrokerTarget | EligibleGroupTarget) => {
    setDraft((current) => {
      if (!current) return current;
      const plan = current.definition.deployment || { targetType: "PAPER" as const, authorizationAccepted: false, armOnActivation: false };
      return { ...current, definition: { ...current.definition, deployment: { ...plan, targetType: target.targetType, targetId: target.targetId, targetLabel: target.label, authorizationAccepted: false, armOnActivation: false } } };
    });
    setDirty(true);
    setWizardTargetPickerMode(null);
    setEligible(null);
    setMessage(`${target.label} selected. Explicitly authorize it in Execution Destination before activation.`);
  };

  const linkBrokerConnection = async (apiKey: string, apiSecret: string, connectionId?: string) => {
    if (!workspace || (addSlot === null && !wizardTargetPickerMode)) return;
    setBusy(true);
    try {
      const result = connectionId
        ? await strategyConnectionApi.rotate(connectionId, apiKey, apiSecret)
        : await strategyConnectionApi.connect(apiKey, apiSecret);
      const connectedId = result.cloud.connection.id;
      setMessage(connectionId ? "Credentials rotated. Black Cloud is reconciling the persistent connection." : "Broker authenticated. Black Cloud is reconciling it before target authorization.");
      let next = await refreshTargetPicker();
      if (!editingBinding && !connectionId) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const target = next?.brokerAccounts.find((item) => item.targetId === connectedId);
          if (target?.validation.eligible) {
            if (wizardTargetPickerMode) selectWizardTarget(target);
            else await addTarget(target);
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          next = await refreshTargetPicker();
        }
        setMessage("Connection saved permanently. Black Cloud is still authenticating its private stream; use LINK TO TARGET when it becomes READY.");
      } else {
        await loadWorkspace(workspace.strategy.id);
        setMessage("Connection credentials were modified without changing its strategy slot. Black Cloud is revalidating readiness.");
      }
    } catch (error) { setMessage(errorMessage(error, "Broker connection could not be linked.")); throw error; }
    finally { setBusy(false); }
  };

  const activateExistingBrokerConnection = async (accountId: string) => {
    if (!workspace || (addSlot === null && !wizardTargetPickerMode)) return;
    setBusy(true);
    try {
      const activated = await activateBlackCloudConnectionViaApi(accountId, { allowStrategyExecution: true, allowInvestmentGroupExecution: true });
      if (!activated?.connection.id) throw new Error("The existing broker account could not be enabled for Strategy Lab.");
      setMessage("Existing broker enabled for permanent Black Cloud execution. Its private stream is now reconciling.");
      let next = await refreshTargetPicker();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const target = next?.brokerAccounts.find((item) => item.targetId === activated.connection.id);
        if (target?.validation.eligible) {
          if (wizardTargetPickerMode) selectWizardTarget(target);
          else await addTarget(target);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        next = await refreshTargetPicker();
      }
      setMessage("Broker authorization is saved permanently. Black Cloud is still reconciling; select LINK TO TARGET as soon as its status becomes READY.");
    } catch (error) { setMessage(errorMessage(error, "Existing broker could not be enabled for Strategy Lab.")); throw error; }
    finally { setBusy(false); }
  };

  const removeBrokerConnection = async (connectionId: string) => {
    setBusy(true);
    try {
      await strategyConnectionApi.remove(connectionId);
      await refreshTargetPicker();
      setMessage("Persistent broker connection removed. Broker-native orders were preserved and no order mutation was submitted.");
    } catch (error) { setMessage(errorMessage(error, "Broker connection could not be removed.")); throw error; }
    finally { setBusy(false); }
  };

  const addTarget = async (target: EligibleBrokerTarget | EligibleGroupTarget) => {
    if (!workspace || addSlot === null || !target.validation.eligible) return;
    setBusy(true);
    try {
      await strategyAutomationApi.addTarget(workspace.strategy.id, addSlot, target.targetType, target.targetId, workspace.strategy.marketType, workspace.paper?.capitalPolicy || workspace.strategy.globalCapitalPolicy);
      await loadWorkspace(workspace.strategy.id); setAddSlot(null); setEligible(null);
      setMessage("Execution target prepared. Review its risk policy, then arm it explicitly when ready.");
    } catch (error) { setMessage(errorMessage(error, "Target could not be prepared.")); }
    finally { setBusy(false); }
  };

  const targetAction = async (bindingId: string, action: "arm" | "pause" | "resume") => {
    if (!workspace) return;
    const binding = workspace.bindings.find((item) => item.id === bindingId);
    if (!binding) return;
    setBusy(true);
    try { await strategyAutomationApi.targetAction(workspace.strategy.id, binding, action); await loadWorkspace(workspace.strategy.id); setMessage(action === "arm" ? "Strategy target armed after server-side validation." : action === "pause" ? "Strategy target paused." : "Strategy target revalidated and resumed."); }
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

  const applyExecutionConfiguration = async (baseDefinition: StrategyAutomationDefinition, basePolicy: StrategyCapitalPolicy, sourceKey: string, panel: StrategyControlPanel, nativeSettings?: Record<string, unknown>) => {
    if (!workspace || busy) return;
    const strategyId = workspace.strategy.id;
    type SettingsMutationStage = "SAVE_DRAFT" | "UPDATE_GLOBAL_POLICY" | "APPLY_DESTINATION";
    let mutationStage: SettingsMutationStage = "SAVE_DRAFT";
    let completedMutationStages = 0;
    setBusy(true);
    setMessage("Saving the strategy-native inputs and execution properties…");
    try {
      const configured = baseDefinition.runtimeKind === "builtin-superatr-seven-step"
        ? applyStrategyControlPanel(baseDefinition, basePolicy, panel)
        : applySharedStrategyControlPanel(baseDefinition, basePolicy, panel, nativeSettings);
      const nextDefinition: StrategyAutomationDefinition = {
        ...configured.definition,
        paper: { ...configured.definition.paper, capitalPolicy: sourceKey === "paper" ? configured.capitalPolicy : configured.definition.paper?.capitalPolicy },
      };
      let next = await strategyAutomationApi.saveDraft(workspace.strategy.id, workspace.strategy.name, nextDefinition, workspace.strategy.draftRevision || 0);
      completedMutationStages = 1;
      mutationStage = "UPDATE_GLOBAL_POLICY";
      next = await strategyAutomationApi.updateGlobalPolicy(next.strategy.id, next.strategy.draftRevision || 0, expandedGlobalPolicy(workspace.strategy.globalCapitalPolicy, configured.capitalPolicy));
      completedMutationStages = 2;
      mutationStage = "APPLY_DESTINATION";
      let successMessage: string;
      if (sourceKey === "paper") {
        const openPaperPositions = Array.isArray(paperData?.positions) ? paperData.positions.length : 0;
        const certified = nextDefinition.indicator?.runtimeStatus === "CERTIFIED";
        if (certified && !openPaperPositions && workspace.bindings.length === 0) {
          next = await strategyAutomationApi.publishDraft(next.strategy.id, next.strategy.draftRevision || 0);
          if (!next.strategy.publishedVersion) throw new Error("The immutable strategy version was not created.");
          next = await strategyAutomationApi.startVersion(next.strategy.id, next.strategy.publishedVersion);
          if (next.paper && Math.abs(next.paper.demoEquity - panel.properties.initialCapital) > 0.005) {
            const reset = await strategyAutomationApi.paperAction(next.strategy.id, "reset", next.paper.rowVersion, { demoEquity: panel.properties.initialCapital });
            next = { ...next, paper: reset.paper };
          }
          successMessage = `Strategy V${next.strategy.runningVersion} is active. Paper sizing now uses ${panel.properties.orderSizeValue}${panel.properties.orderSizeMode === "PERCENT_EQUITY" ? "% of account equity" : panel.properties.orderSizeMode === "FIXED_USDT" ? " USDT" : " units"}.`;
        } else if (certified) {
          if (workspace.paper) await strategyAutomationApi.configurePaper(workspace.strategy.id, workspace.paper.rowVersion, configured.capitalPolicy);
          successMessage = "Sizing and leverage were applied to the current Paper account. Signal/TP input changes are saved as the next immutable draft and will activate after current positions and live bindings are flat or migrated.";
        } else {
          successMessage = "Native script inputs and strategy properties were saved. Paper and live execution remain locked until this script receives a certified VPS runtime.";
        }
      } else {
        const binding = workspace.bindings.find((item) => item.id === sourceKey);
        if (!binding) throw new Error("The selected execution destination is no longer attached.");
        await strategyAutomationApi.updateTarget(workspace.strategy.id, binding, configured.capitalPolicy);
        const targetLabel = binding.targetLabel || binding.targetProvider || "Execution target";
        successMessage = binding.status === "LIVE"
          ? `${targetLabel} passed the replacement-policy execution preflight and remains armed. It now enforces the selected equity/USDT sizing and side leverage. Signal/TP inputs are saved as the next immutable strategy draft.`
          : `${targetLabel} now enforces the selected equity/USDT sizing and side leverage. Its lifecycle state was not changed. Signal/TP inputs are saved as the next immutable strategy draft.`;
      }
      completedMutationStages = 3;
      onDefinitionChange(nextDefinition);
      const refreshed = await strategyAutomationApi.get(workspace.strategy.id);
      setWorkspace(refreshed);
      setDraft(hydrateDraft(refreshed));
      setDirty(false);
      await loadList();
      setMessage(successMessage);
    } catch (error) {
      const failedStage = settingsMutationStageLabel(mutationStage);
      const failure = errorMessage(error, "Strategy settings could not be applied.");

      // A response can fail after its mutation committed. Immediately unmount
      // the settings form and discard its optimistic revision so the same stale
      // payload can never be submitted a second time while recovery is running.
      setWorkspace(null);
      setDraft(null);
      setPaperData(null);
      setDirty(false);

      try {
        const authoritative = await strategyAutomationApi.get(strategyId);
        setWorkspace(authoritative);
        setDraft(hydrateDraft(authoritative));
        setDirty(false);
        onDefinitionChange(authoritative.strategy.draftDefinition || authoritative.strategy.definition);
        await loadList().catch(() => undefined);
        const recoveryMessage = `PARTIAL SAVE RECOVERED · ${failedStage} failed after ${completedMutationStages}/3 mutation stages. The cockpit and draft were reloaded from authoritative VPS state, and the stale revision was discarded. Review the recovered values, then Save again; retry is safe. ${failure}`;
        setMessage(recoveryMessage);
        const retrySafeError = new Error(recoveryMessage) as Error & { cause?: unknown };
        retrySafeError.cause = error;
        throw retrySafeError;
      } catch (recoveryError) {
        if (recoveryError instanceof Error && recoveryError.message.startsWith("PARTIAL SAVE RECOVERED")) throw recoveryError;
        setWorkspace(null);
        setDraft(null);
        setPaperData(null);
        setDirty(false);
        setView("library");
        await loadList().catch(() => undefined);
        const recoveryFailure = errorMessage(recoveryError, "Authoritative VPS reload failed.");
        const recoveryMessage = `PARTIAL SAVE REQUIRES RELOAD · ${failedStage} failed after ${completedMutationStages}/3 mutation stages. Authoritative recovery also failed, so the stale revision was discarded and the settings editor was closed. Reopen the strategy before retrying; do not repeat Save from the old form. ${failure} ${recoveryFailure}`;
        setMessage(recoveryMessage);
        const retrySafeError = new Error(recoveryMessage) as Error & { cause?: unknown };
        retrySafeError.cause = error;
        throw retrySafeError;
      }
    } finally { setBusy(false); }
  };

  return <div className="my-strategy-experience">
    {view === "library" ? <StrategyLibraryPage strategies={strategies} loading={loading || busy} message={message} onCreate={newStrategy} onOpen={(id) => void openStrategy(id)} onModify={(id) => void modifyStrategy(id)} onDelete={setPendingDelete} onBacktest={(strategy) => void openBacktest(strategy)} onPaperAction={(strategy, action) => void libraryPaperAction(strategy, action)} /> : null}
    {view === "qalc" ? <QalcExperience onBack={() => setView("library")} /> : null}
    {view === "wizard" && draft ? <StrategyWizardPage draft={draft} chartTimeframe={chartTimeframe} indicators={indicators} publishedName={workspace?.strategy.name} publishedDefinition={workspace?.strategy.definition} saving={busy} message={message || (dirty ? "Draft changes have not been saved." : undefined)} onChange={(next) => { setDraft(next); setDirty(true); }} onSaveDraft={() => void persistDraft()} onActivate={() => void activateConfiguredStrategy()} onCancel={() => { setView(workspace?.strategy.id ? "cockpit" : "library"); setMessage(undefined); }} /> : null}
    {view === "cockpit" && workspace ? <StrategyCockpitPage workspace={workspace} paperData={paperData} busy={busy} message={message} onEdit={editStrategy} onRefresh={() => void refreshCockpit()} onPaperAction={(action, body) => void paperAction(action, body)} onAddTarget={(slot) => void openTargetPicker(slot)} onModifyTarget={(binding) => void openTargetPicker(binding.slotIndex, binding)} onTargetAction={(bindingId, action) => void targetAction(bindingId, action)} onDisconnectTarget={(bindingId) => void disconnectTarget(bindingId)} onApplyExecutionConfiguration={applyExecutionConfiguration} /> : null}
    {addSlot !== null || wizardTargetPickerMode ? <TargetPicker slot={addSlot ?? 1} initialMode={wizardTargetPickerMode} existingBinding={wizardTargetPickerMode ? null : editingBinding} eligible={eligible} connections={brokerConnections} existingAccounts={existingExchangeConnections} busy={busy} onClose={() => { setAddSlot(null); setEditingBinding(null); setWizardTargetPickerMode(null); setEligible(null); }} onRefresh={() => void refreshTargetPicker()} onConnect={linkBrokerConnection} onActivateExisting={activateExistingBrokerConnection} onRemoveConnection={removeBrokerConnection} onSelect={(target) => wizardTargetPickerMode ? selectWizardTarget(target) : void addTarget(target)} /> : null}
    {pendingDelete ? <DeleteStrategyDialog strategy={pendingDelete} busy={busy} onCancel={() => setPendingDelete(null)} onConfirm={() => void deleteStrategy()} /> : null}
  </div>;
}

function persistedDefinition(draft: StrategyWizardDraft): StrategyAutomationDefinition {
  const base = { ...draft.definition, deployment: { targetType: "PAPER" as const, authorizationAccepted: false, armOnActivation: false }, metadata: { ...draft.definition.metadata, description: draft.description, tags: draft.tags }, paper: { ...draft.definition.paper, capitalPolicy: draft.paperPolicy } };
  if (base.runtimeKind !== "builtin-superatr-seven-step") return base;
  // Script Editor input keys can be variable names or their human-facing Pine
  // labels. Normalize both forms into the immutable native SuperATR contract
  // before the VPS worker ever evaluates a bar.
  return applyStrategyControlPanel(base, draft.paperPolicy, readStrategyControlPanel(base, draft.paperPolicy)).definition;
}

function settingsMutationStageLabel(stage: "SAVE_DRAFT" | "UPDATE_GLOBAL_POLICY" | "APPLY_DESTINATION") {
  if (stage === "SAVE_DRAFT") return "strategy draft";
  if (stage === "UPDATE_GLOBAL_POLICY") return "global risk policy";
  return "selected execution destination";
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

function expandedGlobalPolicy(globalPolicy: StrategyCapitalPolicy, targetPolicy: StrategyCapitalPolicy): StrategyCapitalPolicy {
  return {
    ...globalPolicy,
    strategyAllocationValue: globalPolicy.strategyAllocationMode === targetPolicy.strategyAllocationMode ? Math.max(globalPolicy.strategyAllocationValue, targetPolicy.strategyAllocationValue) : globalPolicy.strategyAllocationValue,
    tradeAmountValue: globalPolicy.tradeAmountMode === targetPolicy.tradeAmountMode ? Math.max(globalPolicy.tradeAmountValue, targetPolicy.tradeAmountValue) : globalPolicy.tradeAmountValue,
    requestedLeverage: Math.max(globalPolicy.requestedLeverage || 1, targetPolicy.requestedLeverage || 1),
    requestedLongLeverage: Math.max(globalPolicy.requestedLongLeverage || globalPolicy.requestedLeverage || 1, targetPolicy.requestedLongLeverage || targetPolicy.requestedLeverage || 1),
    requestedShortLeverage: Math.max(globalPolicy.requestedShortLeverage || globalPolicy.requestedLeverage || 1, targetPolicy.requestedShortLeverage || targetPolicy.requestedLeverage || 1),
    maximumLeverage: Math.max(globalPolicy.maximumLeverage || 1, targetPolicy.maximumLeverage || 1),
    maximumPositionPercent: Math.max(globalPolicy.maximumPositionPercent, targetPolicy.maximumPositionPercent),
    maximumExposurePercent: Math.max(globalPolicy.maximumExposurePercent, targetPolicy.maximumExposurePercent),
    maximumDailyLoss: Math.max(globalPolicy.maximumDailyLoss, targetPolicy.maximumDailyLoss),
    maximumDrawdown: Math.max(globalPolicy.maximumDrawdown, targetPolicy.maximumDrawdown),
    maximumPositions: Math.max(globalPolicy.maximumPositions, targetPolicy.maximumPositions),
    slippageBps: Math.max(globalPolicy.slippageBps, targetPolicy.slippageBps),
  };
}

function TargetPicker({ slot, initialMode, existingBinding, eligible, connections, existingAccounts, busy, onClose, onRefresh, onConnect, onActivateExisting, onRemoveConnection, onSelect }: { slot: number; initialMode: "BROKER" | "GROUP" | null; existingBinding: StrategyTargetBinding | null; eligible: { brokerAccounts: EligibleBrokerTarget[]; groups: EligibleGroupTarget[] } | null; connections: StrategyBrokerConnection[]; existingAccounts: PersistedExchangeConnection[]; busy: boolean; onClose: () => void; onRefresh: () => void; onConnect: (apiKey: string, apiSecret: string, connectionId?: string) => Promise<void>; onActivateExisting: (accountId: string) => Promise<void>; onRemoveConnection: (connectionId: string) => Promise<void>; onSelect: (target: EligibleBrokerTarget | EligibleGroupTarget) => void }) {
  const [mode, setMode] = useState<"BROKER" | "GROUP" | null>(initialMode || (existingBinding?.targetType === "BROKER_ACCOUNT" ? "BROKER" : existingBinding?.targetType === "INVESTMENT_GROUP" ? "GROUP" : null));
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [editingConnectionId, setEditingConnectionId] = useState<string>();
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const eligibleById = new Map((eligible?.brokerAccounts || []).map((item) => [item.targetId, item]));
  const editingConnection = existingBinding?.connectionId ? connections.find((item) => item.id === existingBinding.connectionId) : undefined;
  const linkedAccountIds = new Set(connections.map((item) => item.accountId));
  const activatableAccounts = existingAccounts.filter((item) => !linkedAccountIds.has(item.account.id));
  const connectionLimitReached = connections.length >= 9 && !editingConnectionId;
  const startModify = (connection: StrategyBrokerConnection) => { setEditingConnectionId(connection.id); setApiKey(connection.publicApiKey); setApiSecret(""); setLocalError(undefined); };
  const submitBroker = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) { setLocalError("Both API and API Secret are required."); return; }
    setLocalError(undefined);
    try { await onConnect(apiKey.trim(), apiSecret.trim(), editingConnectionId); setApiSecret(""); }
    catch (error) { setLocalError(errorMessage(error, "Connection failed.")); }
  };
  const removeConnection = async (connectionId: string) => {
    setLocalError(undefined);
    try { await onRemoveConnection(connectionId); }
    catch (error) { setLocalError(errorMessage(error, "Connection removal failed.")); }
  };
  const activateExisting = async (accountId: string) => {
    setLocalError(undefined);
    try { await onActivateExisting(accountId); }
    catch (error) { setLocalError(errorMessage(error, "Existing account activation failed.")); }
  };
  return <div className="strategy-modal-backdrop" role="presentation"><section className="strategy-target-picker strategy-connection-picker" role="dialog" aria-modal="true" aria-label={`${existingBinding ? "Modify" : "Add"} target ${slot}`}>
    <header><div><span>TARGET {String(slot).padStart(2, "0")} · {existingBinding ? "MODIFY" : "NEW CONNECTION"}</span><h2>{existingBinding ? "Connection control" : "Add execution destination"}</h2></div><button type="button" aria-label="Close target picker" onClick={onClose}><X size={16} /></button></header>
    <div className="target-picker-warning"><LockKeyhole size={13} /><span>Credentials are encrypted on the VPS. API Secret is never returned after submission. Testnet endpoints are rejected; Bybit Mainnet and Mainnet Demo are detected server-side.</span></div>
    {!mode ? <div className="connection-type-menu"><button type="button" onClick={() => setMode("BROKER")}><KeyRound size={18} /><span>BROKER CONNECTION</span><strong>Direct trade-only API connection</strong></button><button type="button" onClick={() => setMode("GROUP")}><Building2 size={18} /><span>INVESTMENT GROUP</span><strong>Link a group you own or manage</strong></button></div> : null}
    {mode === "BROKER" ? <div className="broker-connection-flow">
      <div className="connection-flow-head"><button type="button" onClick={() => existingBinding ? onClose() : setMode(null)}>BACK</button><button type="button" onClick={onRefresh}><RefreshCw size={12} /> REFRESH</button></div>
      <div className="strategy-connection-count"><span>PERSISTENT BROKER CONNECTIONS</span><strong>{connections.length} / 9</strong></div>
      {activatableAccounts.length ? <div className="persistent-connection-list existing-exchange-account-list">{activatableAccounts.map((item) => <article key={item.account.id}><header><div><span>{String(item.account.exchange).toUpperCase()} · EXISTING BLACK TERMINAL ACCOUNT</span><strong>{item.account.accountName}</strong></div><em>{item.lifecycle}</em></header><p>{item.account.executionEnvironment === "DEMO" ? "MAINNET DEMO" : "MAINNET REAL"} · {item.account.apiHealth} · STORED VPS CREDENTIAL</p><footer><button type="button" className="link-connection-button" disabled={busy || connections.length >= 9} onClick={() => void activateExisting(item.account.id)}><CloudCog size={12} /> ENABLE FOR STRATEGY LAB</button></footer></article>)}</div> : null}
      <div className="credential-form"><label><span>API</span><input autoComplete="off" spellCheck={false} disabled={busy || connectionLimitReached} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Bybit API key" /></label><label><span>API SECRET</span><input type="password" autoComplete="new-password" disabled={busy || connectionLimitReached} value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} placeholder={editingConnectionId ? "Enter the replacement secret" : "Bybit API secret"} /></label><button type="button" className="link-connection-button" disabled={busy || connectionLimitReached} onClick={() => void submitBroker()}><Link2 size={13} /> {editingConnectionId ? "MODIFY CONNECTION" : "LINK CONNECTION"}</button></div>
      {connectionLimitReached ? <div className="connection-local-error"><AlertTriangle size={13} />The maximum of 9 persistent broker connections is active. Modify or remove one before adding another.</div> : null}
      {localError ? <div className="connection-local-error" role="alert"><AlertTriangle size={13} />{localError}</div> : null}
      <div className="persistent-connection-list">{connections.length ? connections.map((connection) => {
        const target = eligibleById.get(connection.id);
        const selected = connection.id === existingBinding?.connectionId;
        return <article key={connection.id} className={selected ? "selected" : ""}><header><div><span>{connection.provider} · {connection.executionEnvironment === "DEMO" ? "MAINNET DEMO" : "MAINNET REAL"}</span><strong>{connection.label}</strong></div><em>{connection.executionReadiness}</em></header><div className="stored-credential-grid"><label><span>API</span><input readOnly value={connection.publicApiKey || "Reconnect required"} /></label><label><span>API SECRET</span><input readOnly type="password" value={connection.apiSecretDisplay} /></label></div><p>{connection.workerState} · {connection.synchronizationState} · VPS PERSISTENT</p><footer>{!existingBinding ? <button type="button" disabled={busy || !target?.validation.eligible} onClick={() => target && onSelect(target)}><ShieldCheck size={12} /> LINK TO TARGET</button> : null}<button type="button" disabled={busy} onClick={() => startModify(connection)}>MODIFY</button>{!selected ? <button type="button" className="danger" disabled={busy} onClick={() => void removeConnection(connection.id)}>REMOVE</button> : null}</footer>{target && !target.validation.eligible ? <small>{target.validation.reasons.join(" · ")}</small> : null}</article>;
      }) : <div className="cockpit-empty-state compact"><Plus size={17} /><strong>No broker connection yet</strong><span>Enter a trade-only Bybit Mainnet or Mainnet Demo key above.</span></div>}</div>
      {editingConnection ? <div className="connection-selected-note"><ShieldCheck size={13} /><span>This strategy slot remains bound to {editingConnection.label} while credentials are rotated and reconciled.</span></div> : null}
    </div> : null}
    {mode === "GROUP" ? <div className="group-connection-flow"><div className="connection-flow-head"><button type="button" onClick={() => existingBinding ? onClose() : setMode(null)}>BACK</button><button type="button" onClick={onRefresh}><RefreshCw size={12} /> REFRESH</button></div>{eligible?.groups.length ? <><div className="eligible-target-list">{eligible.groups.map((group) => <label className={`group-toggle-row${group.validation.eligible ? " eligible" : ""}`} key={group.targetId}><input type="radio" name={`target-group-${slot}`} checked={selectedGroupId === group.targetId} disabled={!group.validation.eligible || busy} onChange={() => setSelectedGroupId(group.targetId)} /><span><b>INVESTMENT GROUP</b><strong>{group.label}</strong><em>{group.validation.eligible ? `${group.activeAuthorizedMembers} active authorized members` : group.validation.reasons.join(" · ")}</em></span></label>)}</div><button type="button" className="link-connection-button group-link-button" disabled={busy || !selectedGroupId} onClick={() => { const group = eligible.groups.find((item) => item.targetId === selectedGroupId); if (group) onSelect(group); }}><Link2 size={13} /> LINK CONNECTION</button></> : <div className="cockpit-empty-state"><Building2 size={19} /><strong>No user-created Investment Group</strong><span>Create or manage a group first. Owned and manager-authorized groups will appear here automatically.</span></div>}</div> : null}
  </section></div>;
}

function DeleteStrategyDialog({ strategy, busy, onCancel, onConfirm }: { strategy: StrategySummary; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="strategy-modal-backdrop" role="presentation">
    <section className="strategy-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-strategy-title">
      <header><div><Trash2 size={15} /><span>DELETE STRATEGY</span></div><button type="button" aria-label="Close delete strategy confirmation" disabled={busy} onClick={onCancel}><X size={15} /></button></header>
      <div className="strategy-delete-dialog-body">
        <h2 id="delete-strategy-title">Delete “{strategy.name}”?</h2>
        <p>This removes the strategy from My Strategy, stops its Paper runtime, pauses active targets and disconnects them after any in-flight command settles. Immutable versions, trades and audit history remain retained.</p>
        <div><AlertTriangle size={15} /><span>No broker order is placed, changed or cancelled and no broker position is closed by deletion. Any existing broker exposure remains at the venue under its current protection.</span></div>
      </div>
      <footer><button type="button" disabled={busy} onClick={onCancel}>CANCEL</button><button type="button" className="danger" disabled={busy} onClick={onConfirm}><Trash2 size={13} /> {busy ? "DELETING…" : "DELETE STRATEGY"}</button></footer>
    </section>
  </div>;
}

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

const DELETION_PAUSABLE_TARGET_STATES = new Set<StrategyTargetBinding["status"]>(["READY", "LIVE", "DEGRADED", "RISK_SUSPENDED"]);
const DELETE_SETTLEMENT_ATTEMPTS = 20;
const DELETE_SETTLEMENT_INTERVAL_MS = 750;

function strategyApiErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}

function waitForDeleteSettlement(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function fixtureWorkspace(base: StrategyAutomationDefinition, indicator?: StrategyIndicatorInstance): StrategyWorkspace {
  const now = new Date().toISOString();
  let bound = indicator ? { ...withWorkflowDefaults(base), runtimeKind: indicator.runtimeKind, indicator, settings: { ...base.settings, ...indicator.settings }, signals: { longEntry: indicator.alerts[0]?.id || "long-entry", shortEntry: indicator.alerts[1]?.id || indicator.alerts[0]?.id || "short-entry" }, paper: { demoEquity: 25_000, capitalPolicy: defaultWizardPaperPolicy("FUTURES") } } : withWorkflowDefaults(base);
  let policy = defaultWizardPaperPolicy(bound.marketType);
  const controlPreview = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("strategyControlPreview") === "1";
  if (controlPreview) {
    const panel = readStrategyControlPanel(bound, policy, 5_000);
    panel.inputs = { ...panel.inputs, shortPeriod: 30, longPeriod: 70, trendStrengthThreshold: 3.1, takeProfitAtrLength: 100, atrMultipliers: [100, 70, 120, 300], fixedTakeProfitPercentages: [21, 21, 75], atrExitPercent: 10, fixedExitPercent: 10 };
    panel.properties = { ...panel.properties, initialCapital: 5_000, orderSizeValue: 35, commissionValue: 0.1, longLeverage: 25, shortLeverage: 25, slippageTicks: 1 };
    const configured = applyStrategyControlPanel(bound, policy, panel);
    bound = configured.definition;
    policy = configured.capitalPolicy;
  }
  const strategyName = controlPreview ? "SuperATR 7-Step Profit - Strategy [presentTrading]" : "Hidden Distribution Swing";
  return {
    strategy: { id: "preview-strategy-1", name: strategyName, runtimeKind: bound.runtimeKind, symbol: bound.symbol || "BTCUSDT", timeframe: "4h", marketType: bound.marketType, exchange: "bybit", currentVersion: 3, publishedVersion: 3, runningVersion: 3, draftRevision: 7, draftUpdatedAt: now, hasDraftChanges: false, status: "PAPER_ACTIVE", createdAt: now, updatedAt: now, definition: bound, draftDefinition: bound, draftName: strategyName, draftBaseVersion: 3, globalCapitalPolicy: policy },
    versions: [{ version: 3, name: strategyName, definition: bound, status: "PUBLISHED", createdAt: now }],
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
