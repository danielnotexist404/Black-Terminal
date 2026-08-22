import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  CloudCog,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Unplug,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import { strategyAutomationApi } from "./strategyAutomationApi";
import type {
  EligibleBrokerTarget,
  EligibleGroupTarget,
  StrategyAutomationDefinition,
  StrategyCapitalPolicy,
  StrategyPaperAccount,
  StrategySummary,
  StrategyTargetBinding,
  StrategyTargetSnapshot,
  StrategyWorkspace,
} from "./strategyAutomation.types";

type Props = { definition: StrategyAutomationDefinition };
type TargetResource =
  | "overview"
  | "members"
  | "positions"
  | "orders"
  | "executions"
  | "trades"
  | "analytics"
  | "risk"
  | "logs";
type CapitalEditor =
  | { kind: "paper"; paper: StrategyPaperAccount }
  | {
      kind: "target";
      binding: StrategyTargetBinding;
      snapshot?: StrategyTargetSnapshot;
    };

const brokerTargetTabs: Array<{ id: TargetResource; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Open Positions" },
  { id: "orders", label: "Open Orders" },
  { id: "executions", label: "Recent Executions" },
  { id: "trades", label: "Closed Trades" },
  { id: "analytics", label: "Analytics" },
  { id: "risk", label: "Risk" },
  { id: "logs", label: "Logs" },
];

const groupTargetTabs: Array<{ id: TargetResource; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "positions", label: "Positions" },
  { id: "executions", label: "Executions" },
  { id: "analytics", label: "Analytics" },
  { id: "risk", label: "Risk" },
  { id: "logs", label: "Logs" },
];

export function StrategyAutomationPanel({ definition }: Props) {
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [workspace, setWorkspace] = useState<StrategyWorkspace | null>(null);
  const [strategyName, setStrategyName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "Loading the server-authoritative strategy cockpit…",
  );
  const [addSlot, setAddSlot] = useState<number | null>(null);
  const [eligible, setEligible] = useState<{
    brokerAccounts: EligibleBrokerTarget[];
    groups: EligibleGroupTarget[];
  } | null>(null);
  const [targetTab, setTargetTab] = useState<"broker" | "group">("broker");
  const [selectedBindingId, setSelectedBindingId] = useState<string | null>(
    null,
  );
  const [selectedPaper, setSelectedPaper] = useState(true);
  const [resource, setResource] = useState<TargetResource>("overview");
  const [resourcePayload, setResourcePayload] = useState<unknown>(null);
  const [capitalEditor, setCapitalEditor] = useState<CapitalEditor | null>(
    null,
  );
  const [disconnectBinding, setDisconnectBinding] =
    useState<StrategyTargetBinding | null>(null);
  const [paperFundsAction, setPaperFundsAction] = useState<
    "top-up" | "reset" | null
  >(null);
  const [expandAll, setExpandAll] = useState(false);
  const generation = useRef(0);

  const loadWorkspace = useCallback(
    async (strategyId: string, signal?: AbortSignal) => {
      const current = ++generation.current;
      const next = await strategyAutomationApi.get(strategyId, signal);
      if (current !== generation.current || signal?.aborted) return;
      setWorkspace(next);
      setStrategyName(next.strategy.name);
      setSelectedBindingId((value) =>
        value && next.bindings.some((item) => item.id === value)
          ? value
          : next.bindings[0]?.id || null,
      );
      setMessage(
        "Strategy definition, Paper Target and occupied live slots restored from Black Cloud.",
      );
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    strategyAutomationApi
      .list(controller.signal)
      .then(async ({ strategies: rows }) => {
        if (controller.signal.aborted) return;
        setStrategies(rows);
        if (rows[0]) await loadWorkspace(rows[0].id, controller.signal);
        else {
          setWorkspace(null);
          setStrategyName("");
          setMessage(
            "Name and save the current model to create its Paper Target and ten empty live slots.",
          );
        }
      })
      .catch(
        (error) =>
          !controller.signal.aborted &&
          setMessage(
            error instanceof Error
              ? error.message
              : "Strategy cockpit failed to load.",
          ),
      )
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [loadWorkspace]);

  useEffect(() => {
    if (!workspace?.strategy.id) return;
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const snapshot = await strategyAutomationApi.snapshot(
          workspace.strategy.id,
          controller.signal,
        );
        if (cancelled) return;
        setWorkspace((current) =>
          current
            ? {
                ...current,
                paper: snapshot.paper,
                snapshots: snapshot.targets,
                runtime: snapshot.runtime,
              }
            : current,
        );
      } catch (error) {
        if (!cancelled && !controller.signal.aborted)
          setMessage(
            error instanceof Error
              ? error.message
              : "Strategy snapshot is unavailable.",
          );
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [workspace?.strategy.id]);

  useEffect(() => {
    if (!workspace || !selectedBindingId || resource === "overview") {
      setResourcePayload(null);
      return;
    }
    const controller = new AbortController();
    strategyAutomationApi
      .targetData<unknown>(
        workspace.strategy.id,
        selectedBindingId,
        resource,
        controller.signal,
      )
      .then(
        (payload) =>
          !controller.signal.aborted && setResourcePayload(payload[resource]),
      )
      .catch(
        (error) =>
          !controller.signal.aborted &&
          setMessage(
            error instanceof Error
              ? error.message
              : "Target data is unavailable.",
          ),
      );
    return () => controller.abort();
  }, [resource, selectedBindingId, workspace?.strategy.id]);

  const refreshList = async (selectId?: string) => {
    const { strategies: rows } = await strategyAutomationApi.list();
    setStrategies(rows);
    const id = selectId || workspace?.strategy.id || rows[0]?.id;
    if (id) await loadWorkspace(id);
  };

  const saveStrategy = async () => {
    if (!strategyName.trim()) {
      setMessage("Name the strategy before saving it.");
      return;
    }
    setBusy(true);
    try {
      const next = workspace
        ? await strategyAutomationApi.save(
            workspace.strategy.id,
            strategyName.trim(),
            definition,
          )
        : await strategyAutomationApi.create(strategyName.trim(), definition);
      setWorkspace(next);
      setStrategyName(next.strategy.name);
      await refreshList(next.strategy.id);
      setMessage(
        workspace
          ? "Named strategy definition saved."
          : "Strategy created with Paper active and all ten live targets empty.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Strategy save failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const openAddTarget = async (slotIndex: number) => {
    if (!workspace) return;
    setAddSlot(slotIndex);
    setEligible(null);
    setTargetTab("broker");
    setBusy(true);
    try {
      setEligible(
        await strategyAutomationApi.eligibleTargets(workspace.strategy.id),
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Eligible targets are unavailable.",
      );
      setAddSlot(null);
    } finally {
      setBusy(false);
    }
  };

  const addTarget = async (
    target: EligibleBrokerTarget | EligibleGroupTarget,
  ) => {
    if (!workspace || addSlot === null || !target.validation.eligible) return;
    setBusy(true);
    try {
      await strategyAutomationApi.addTarget(
        workspace.strategy.id,
        addSlot,
        target.targetType,
        target.targetId,
        workspace.strategy.marketType,
      );
      await loadWorkspace(workspace.strategy.id);
      setAddSlot(null);
      setEligible(null);
      setSelectedPaper(false);
      setMessage(
        "Target validated and added with 0% live allocation. It is not armed.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Target could not be added.",
      );
    } finally {
      setBusy(false);
    }
  };

  const targetAction = async (
    binding: StrategyTargetBinding,
    action: "pause" | "resume",
  ) => {
    if (!workspace) return;
    setBusy(true);
    try {
      await strategyAutomationApi.targetAction(
        workspace.strategy.id,
        binding,
        action,
      );
      await loadWorkspace(workspace.strategy.id);
      setMessage(
        `Target ${action === "pause" ? "paused" : "revalidated and restored to READY"}.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Target action failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const reorderTarget = async (
    binding: StrategyTargetBinding,
    direction: -1 | 1,
  ) => {
    if (!workspace) return;
    const slotIndex = binding.slotIndex + direction;
    if (slotIndex < 1 || slotIndex > 10) return;
    const neighbor = bindingBySlot.get(slotIndex);
    const assignments = [
      {
        bindingId: binding.id,
        slotIndex,
        expectedVersion: binding.rowVersion,
      },
      ...(neighbor
        ? [
            {
              bindingId: neighbor.id,
              slotIndex: binding.slotIndex,
              expectedVersion: neighbor.rowVersion,
            },
          ]
        : []),
    ];
    setBusy(true);
    try {
      await strategyAutomationApi.reorderTargets(
        workspace.strategy.id,
        assignments,
      );
      await loadWorkspace(workspace.strategy.id);
      setMessage(
        `Target moved to slot ${String(slotIndex).padStart(2, "0")} without changing its identity or runtime state.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Target reorder failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (policy: string) => {
    if (!workspace || !disconnectBinding) return;
    setBusy(true);
    try {
      await strategyAutomationApi.disconnectTarget(
        workspace.strategy.id,
        disconnectBinding,
        policy,
      );
      await loadWorkspace(workspace.strategy.id);
      setDisconnectBinding(null);
      setSelectedBindingId(null);
      setSelectedPaper(true);
      setMessage(
        "Target disconnected. Its slot is empty and historical records remain preserved.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Target disconnect failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const saveCapitalPolicy = async (policy: StrategyCapitalPolicy) => {
    if (!workspace || !capitalEditor) return;
    setBusy(true);
    try {
      if (capitalEditor.kind === "paper")
        await strategyAutomationApi.configurePaper(
          workspace.strategy.id,
          capitalEditor.paper.rowVersion,
          policy,
        );
      else
        await strategyAutomationApi.updateTarget(
          workspace.strategy.id,
          capitalEditor.binding,
          policy,
        );
      await loadWorkspace(workspace.strategy.id);
      setCapitalEditor(null);
      setMessage(
        capitalEditor.kind === "paper"
          ? "Paper capital policy saved."
          : "Live target policy version saved. Risk increases require revalidation and re-arming.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Capital policy could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const paperAction = async (
    action: "start" | "pause" | "top-up" | "reset",
    body: Record<string, unknown> = {},
  ) => {
    if (!workspace?.paper) return false;
    setBusy(true);
    try {
      await strategyAutomationApi.paperAction(
        workspace.strategy.id,
        action,
        workspace.paper.rowVersion,
        body,
      );
      await loadWorkspace(workspace.strategy.id);
      setMessage(`Paper target ${action.replace("-", " ")} completed.`);
      return true;
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Paper action failed.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const bindingBySlot = useMemo(
    () =>
      new Map(
        (workspace?.bindings || []).map((item) => [item.slotIndex, item]),
      ),
    [workspace?.bindings],
  );
  const snapshotByBinding = useMemo(
    () =>
      new Map(
        (workspace?.snapshots || []).map((item) => [item.bindingId, item]),
      ),
    [workspace?.snapshots],
  );
  const selectedBinding =
    workspace?.bindings.find((item) => item.id === selectedBindingId) || null;
  const selectedSnapshot = selectedBinding
    ? snapshotByBinding.get(selectedBinding.id)
    : undefined;

  if (loading)
    return (
      <div className="strategy-automation-loading">
        <RefreshCw size={18} className="spin" /> BLACK CLOUD IS RESTORING MY
        STRATEGY
      </div>
    );

  return (
    <div className="strategy-automation">
      <header className="strategy-automation-hero">
        <div>
          <Bot size={18} />
          <span>BLACK CORE AUTOMATION</span>
          <strong>MY STRATEGY</strong>
          <p>
            Persistent paper runtime · bounded live targets ·
            server-authoritative state
          </p>
        </div>
        <div className="strategy-automation-save">
          {strategies.length > 0 && (
            <>
              <select
                aria-label="Saved strategy"
                value={workspace?.strategy.id || ""}
                onChange={(event) => void loadWorkspace(event.target.value)}
              >
                {!workspace && <option value="">NEW UNSAVED STRATEGY</option>}
                {strategies.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !workspace}
                onClick={() => {
                  generation.current += 1;
                  setWorkspace(null);
                  setStrategyName("");
                  setSelectedBindingId(null);
                  setSelectedPaper(true);
                  setMessage(
                    "Name the new strategy before creating its Paper Target and ten empty live slots.",
                  );
                }}
              >
                <Plus size={14} /> NEW
              </button>
            </>
          )}
          <input
            aria-label="Strategy name"
            value={strategyName}
            maxLength={80}
            placeholder="NAME STRATEGY BEFORE SAVING"
            onChange={(event) => setStrategyName(event.target.value)}
          />
          <button
            type="button"
            disabled={busy || !strategyName.trim()}
            onClick={() => void saveStrategy()}
          >
            <Save size={14} /> {workspace ? "SAVE STRATEGY" : "CREATE STRATEGY"}
          </button>
        </div>
      </header>

      <div className="strategy-automation-status">
        <span
          className={
            message.toLowerCase().includes("fail") ||
            message.toLowerCase().includes("unavailable")
              ? "warning"
              : ""
          }
        >
          {message}
        </span>
        {workspace && (
          <b>
            {workspace.strategy.symbol} · {workspace.strategy.timeframe} ·{" "}
            {workspace.strategy.marketType}
          </b>
        )}
      </div>

      {!workspace ? (
        <NewStrategyState definition={definition} />
      ) : (
        <>
          <section className="strategy-automation-overview-bar">
            <div>
              <span>STRATEGY</span>
              <b>{workspace.strategy.name}</b>
            </div>
            <div>
              <span>VERSION</span>
              <b>V{workspace.strategy.currentVersion}</b>
            </div>
            <div>
              <span>PAPER RUNTIME</span>
              <b
                className={
                  workspace.paper?.status === "ACTIVE" ? "positive" : "neutral"
                }
              >
                {workspace.paper?.status || "UNAVAILABLE"}
              </b>
            </div>
            <div>
              <span>BLACK CLOUD</span>
              <b
                className={
                  workspace.runtime?.state === "LIVE" ? "positive" : "neutral"
                }
              >
                {workspace.runtime?.state || "STARTING"}
              </b>
            </div>
            <div>
              <span>LIVE CAPACITY</span>
              <b>{workspace.bindings.length} / 10</b>
            </div>
            <div>
              <span>LIVE EXECUTION</span>
              <b className="negative">ROLLOUT LOCKED</b>
            </div>
          </section>

          {workspace.paper && (
            <PaperTargetCard
              paper={workspace.paper}
              selected={selectedPaper}
              onSelect={() => {
                setSelectedPaper(true);
                setSelectedBindingId(null);
              }}
              onConfigure={() =>
                setCapitalEditor({ kind: "paper", paper: workspace.paper! })
              }
              onAction={paperAction}
              onFundsAction={setPaperFundsAction}
            />
          )}

          <section className="strategy-target-section">
            <div className="strategy-target-section-head">
              <div>
                <span>LIVE TARGETS</span>
                <strong>DYNAMIC 10-SLOT MATRIX</strong>
                <p>
                  Empty slots have no database row, broker stream, portfolio
                  subscription or analytics worker.
                </p>
              </div>
              <button
                type="button"
                disabled={!workspace.bindings.length}
                onClick={() => setExpandAll((value) => !value)}
              >
                {expandAll ? (
                  <ChevronUp size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                {expandAll
                  ? "COLLAPSE OCCUPIED"
                  : "EXPAND ALL OCCUPIED TARGETS"}
              </button>
            </div>
            <div className="strategy-target-matrix">
              {Array.from({ length: 10 }, (_, index) => {
                const slotIndex = index + 1;
                const binding = bindingBySlot.get(slotIndex);
                return binding ? (
                  <OccupiedTargetTile
                    key={slotIndex}
                    binding={binding}
                    snapshot={snapshotByBinding.get(binding.id)}
                    selected={
                      selectedBindingId === binding.id && !selectedPaper
                    }
                    onOpen={() => {
                      setSelectedPaper(false);
                      setSelectedBindingId(binding.id);
                      setResource("overview");
                    }}
                    onConfigure={() =>
                      setCapitalEditor({
                        kind: "target",
                        binding,
                        snapshot: snapshotByBinding.get(binding.id),
                      })
                    }
                    onPause={() =>
                      void targetAction(
                        binding,
                        binding.status === "PAUSED" ? "resume" : "pause",
                      )
                    }
                    onDisconnect={() => setDisconnectBinding(binding)}
                    onMoveLeft={() => void reorderTarget(binding, -1)}
                    onMoveRight={() => void reorderTarget(binding, 1)}
                  />
                ) : (
                  <button
                    key={slotIndex}
                    type="button"
                    className="strategy-target-empty"
                    disabled={busy || workspace.bindings.length >= 10}
                    onClick={() => void openAddTarget(slotIndex)}
                  >
                    <span>TARGET {String(slotIndex).padStart(2, "0")}</span>
                    <em>No account allocated</em>
                    <b>
                      <Plus size={13} /> ADD ACCOUNT OR GROUP
                    </b>
                  </button>
                );
              })}
            </div>
            {workspace.bindings.length === 0 && (
              <div className="strategy-no-live-targets">
                <CloudCog size={24} />
                <strong>NO LIVE TARGETS ALLOCATED</strong>
                <span>
                  Paper Trading is active. Add a broker account or My Investment
                  Group when ready.
                </span>
                <button type="button" onClick={() => void openAddTarget(1)}>
                  <Plus size={14} /> ADD LIVE TARGET
                </button>
              </div>
            )}
          </section>

          {expandAll && workspace.bindings.length > 0 && (
            <div className="strategy-expanded-targets">
              {workspace.bindings.map((binding) => (
                <TargetCompactSummary
                  key={binding.id}
                  binding={binding}
                  snapshot={snapshotByBinding.get(binding.id)}
                />
              ))}
            </div>
          )}

          {selectedPaper && workspace.paper ? (
            <PaperCockpit
              paper={workspace.paper}
              runtime={workspace.runtime}
              strategyId={workspace.strategy.id}
            />
          ) : selectedBinding ? (
            <TargetCockpit
              binding={selectedBinding}
              snapshot={selectedSnapshot}
              resource={resource}
              payload={resourcePayload}
              onResource={setResource}
            />
          ) : null}
        </>
      )}

      {addSlot !== null && (
        <AddTargetDialog
          slotIndex={addSlot}
          activeTab={targetTab}
          eligible={eligible}
          busy={busy}
          onTab={setTargetTab}
          onAdd={(target) => void addTarget(target)}
          onClose={() => {
            setAddSlot(null);
            setEligible(null);
          }}
        />
      )}
      {capitalEditor && (
        <CapitalPolicyDrawer
          editor={capitalEditor}
          busy={busy}
          onSave={(policy) => void saveCapitalPolicy(policy)}
          onClose={() => setCapitalEditor(null)}
        />
      )}
      {disconnectBinding && (
        <DisconnectDialog
          binding={disconnectBinding}
          busy={busy}
          onConfirm={(policy) => void disconnect(policy)}
          onClose={() => setDisconnectBinding(null)}
        />
      )}
      {paperFundsAction && workspace?.paper && (
        <PaperFundsDialog
          action={paperFundsAction}
          paper={workspace.paper}
          busy={busy}
          onClose={() => setPaperFundsAction(null)}
          onConfirm={(amount) => {
            void paperAction(
              paperFundsAction,
              paperFundsAction === "top-up"
                ? { amount }
                : { demoEquity: amount },
            ).then((succeeded) => succeeded && setPaperFundsAction(null));
          }}
        />
      )}
    </div>
  );
}

function NewStrategyState({
  definition,
}: {
  definition: StrategyAutomationDefinition;
}) {
  return (
    <div className="strategy-new-state">
      <Bot size={30} />
      <strong>CREATE A NAMED STRATEGY</strong>
      <span>
        The saved strategy will begin with one active Paper Target and ten
        visibly empty live slots.
      </span>
      <div>
        <b>{definition.symbol}</b>
        <b>{definition.timeframe}</b>
        <b>{definition.marketType}</b>
        <b>{definition.runtimeKind.replaceAll("-", " ").toUpperCase()}</b>
      </div>
      <p>
        No broker account will be selected, armed or allocated automatically.
      </p>
    </div>
  );
}

function PaperTargetCard({
  paper,
  selected,
  onSelect,
  onConfigure,
  onAction,
  onFundsAction,
}: {
  paper: StrategyPaperAccount;
  selected: boolean;
  onSelect: () => void;
  onConfigure: () => void;
  onAction: (
    action: "start" | "pause" | "top-up" | "reset",
    body?: Record<string, unknown>,
  ) => void;
  onFundsAction: (action: "top-up" | "reset") => void;
}) {
  return (
    <section
      className={`strategy-paper-target${selected ? " selected" : ""}`}
      onClick={onSelect}
    >
      <div className="strategy-paper-icon">
        <Bot size={22} />
      </div>
      <div>
        <span>PAPER TARGET · SEPARATE VIRTUAL ACCOUNT</span>
        <strong>PAPER ACCOUNT</strong>
        <em>
          {paper.marketType} · {paper.status}
        </em>
      </div>
      <Metric label="Demo equity" value={money(paper.demoEquity)} />
      <Metric label="Available" value={money(paper.availableBalance)} />
      <Metric
        label="Allocated"
        value={policyAmount(
          paper.capitalPolicy.strategyAllocationMode,
          paper.capitalPolicy.strategyAllocationValue,
        )}
      />
      <Metric
        label="Per trade"
        value={policyAmount(
          paper.capitalPolicy.tradeAmountMode,
          paper.capitalPolicy.tradeAmountValue,
        )}
      />
      <Metric
        label="Leverage"
        value={
          paper.marketType === "SPOT"
            ? "SPOT — UNLEVERAGED"
            : `${paper.preview.effectiveLeverage}x`
        }
      />
      <div className="strategy-paper-actions">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onConfigure();
          }}
        >
          <Settings2 size={13} /> CONFIGURE CAPITAL
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onAction(paper.status === "ACTIVE" ? "pause" : "start");
          }}
        >
          {paper.status === "ACTIVE" ? <Pause size={13} /> : <Play size={13} />}
          {paper.status === "ACTIVE" ? "PAUSE" : "START"}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onFundsAction("top-up");
          }}
        >
          <Plus size={13} /> TOP UP DEMO EQUITY
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onFundsAction("reset");
          }}
        >
          <RefreshCw size={13} /> RESET PAPER ACCOUNT
        </button>
      </div>
    </section>
  );
}

function OccupiedTargetTile({
  binding,
  snapshot,
  selected,
  onOpen,
  onConfigure,
  onPause,
  onDisconnect,
  onMoveLeft,
  onMoveRight,
}: {
  binding: StrategyTargetBinding;
  snapshot?: StrategyTargetSnapshot;
  selected: boolean;
  onOpen: () => void;
  onConfigure: () => void;
  onPause: () => void;
  onDisconnect: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
}) {
  return (
    <article
      className={`strategy-target-occupied${selected ? " selected" : ""}`}
    >
      <button className="strategy-target-open" type="button" onClick={onOpen}>
        <span>TARGET {String(binding.slotIndex).padStart(2, "0")}</span>
        <strong>
          {binding.targetLabel ||
            (binding.targetType === "BROKER_ACCOUNT"
              ? "BROKER ACCOUNT"
              : "MY INVESTMENT GROUP")}
        </strong>
        <em>
          {binding.targetProvider ? `${binding.targetProvider} · ` : ""}
          {binding.marketType} · {binding.status}
        </em>
        <div>
          <small>
            Equity <b>{money(snapshot?.equity)}</b>
          </small>
          <small>
            Allocated{" "}
            <b>
              {policyAmount(
                binding.capitalPolicy.strategyAllocationMode,
                binding.capitalPolicy.strategyAllocationValue,
              )}
            </b>
          </small>
          <small>
            Strategy capital <b>{money(snapshot?.allocatedStrategyCapital)}</b>
          </small>
          <small>
            Requested lev.{" "}
            <b>
              {binding.marketType === "SPOT"
                ? "SPOT — UNLEVERAGED"
                : `${binding.capitalPolicy.requestedLeverage || 1}x`}
            </b>
          </small>
          <small>
            Effective lev.{" "}
            <b>
              {binding.marketType === "SPOT"
                ? "SPOT — UNLEVERAGED"
                : `${snapshot?.effectiveLeverage || 1}x`}
            </b>
          </small>
        </div>
      </button>
      <div className="strategy-target-tile-actions">
        <button
          type="button"
          aria-label="Move target one slot left"
          disabled={binding.slotIndex === 1}
          onClick={onMoveLeft}
        >
          <ChevronLeft size={12} />
        </button>
        <button
          type="button"
          aria-label="Move target one slot right"
          disabled={binding.slotIndex === 10}
          onClick={onMoveRight}
        >
          <ChevronRight size={12} />
        </button>
        <button type="button" onClick={onOpen}>
          OPEN
        </button>
        <button type="button" onClick={onPause}>
          {binding.status === "PAUSED" ? "RESUME" : "PAUSE"}
        </button>
        <button type="button" onClick={onConfigure}>
          CONFIGURE
        </button>
        <button type="button" onClick={onDisconnect}>
          DISCONNECT
        </button>
      </div>
    </article>
  );
}

function TargetCompactSummary({
  binding,
  snapshot,
}: {
  binding: StrategyTargetBinding;
  snapshot?: StrategyTargetSnapshot;
}) {
  return (
    <article>
      <span>TARGET {String(binding.slotIndex).padStart(2, "0")}</span>
      <b>{binding.targetType.replaceAll("_", " ")}</b>
      <em className={snapshot?.freshness === "LIVE" ? "positive" : "neutral"}>
        {snapshot?.freshness || "UNAVAILABLE"}
      </em>
      <strong>{money(snapshot?.netPnl)} NET</strong>
    </article>
  );
}

function PaperCockpit({
  paper,
  runtime,
  strategyId,
}: {
  paper: StrategyPaperAccount;
  runtime: StrategyWorkspace["runtime"];
  strategyId: string;
}) {
  const [data, setData] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    strategyAutomationApi
      .paperData(strategyId, controller.signal)
      .then((value) => !controller.signal.aborted && setData(value))
      .catch(() => undefined);
    return () => controller.abort();
  }, [strategyId, paper.updatedAt]);
  return (
    <section className="strategy-target-cockpit">
      <header>
        <div>
          <Bot size={16} />
          <span>SELECTED TARGET COCKPIT</span>
          <strong>PAPER ACCOUNT</strong>
        </div>
        <StatusBadge value={runtime?.state || paper.status} />
      </header>
      <div className="strategy-cockpit-metrics">
        <Metric
          label="Equity"
          value={money(paper.demoEquity + paper.unrealizedPnl)}
        />
        <Metric label="Available" value={money(paper.availableBalance)} />
        <Metric
          label="Allocated capital"
          value={money(paper.preview.allocatedStrategyCapital)}
        />
        <Metric
          label="Per-entry capital"
          value={money(paper.preview.entryCapital)}
        />
        <Metric
          label="Estimated notional"
          value={money(paper.preview.estimatedNotional)}
        />
        {paper.marketType === "SPOT" ? (
          <Metric
            label="Quote reserve"
            value={money(paper.preview.quoteAssetReserve)}
          />
        ) : (
          <Metric
            label="Effective leverage"
            value={`${paper.preview.effectiveLeverage}x`}
          />
        )}
        <Metric label="Realized PnL" value={money(paper.realizedPnl)} signed />
        <Metric
          label="Unrealized PnL"
          value={money(paper.unrealizedPnl)}
          signed
        />
        <Metric
          label="Max drawdown"
          value={`${paper.maximumDrawdownPercent.toFixed(2)}%`}
        />
      </div>
      <div className="strategy-cockpit-runtime">
        <span>
          Indicator heartbeat{" "}
          <b>
            {runtime?.lastClosedCandleAt
              ? relative(runtime.lastClosedCandleAt)
              : "WAITING"}
          </b>
        </span>
        <span>
          Last signal{" "}
          <b>
            {runtime?.lastSignalAt ? relative(runtime.lastSignalAt) : "NONE"}
          </b>
        </span>
        <span>
          Open positions{" "}
          <b>{Array.isArray(data?.positions) ? data.positions.length : 0}</b>
        </span>
        <span>
          Closed trades{" "}
          <b>{Array.isArray(data?.trades) ? data.trades.length : 0}</b>
        </span>
        <span>
          Browser independence <b className="positive">VPS OWNED</b>
        </span>
        <span>
          Live broker fan-out <b className="negative">DISABLED</b>
        </span>
      </div>
    </section>
  );
}

function TargetCockpit({
  binding,
  snapshot,
  resource,
  payload,
  onResource,
}: {
  binding: StrategyTargetBinding;
  snapshot?: StrategyTargetSnapshot;
  resource: TargetResource;
  payload: unknown;
  onResource: (resource: TargetResource) => void;
}) {
  const targetTabs =
    binding.targetType === "INVESTMENT_GROUP"
      ? groupTargetTabs
      : brokerTargetTabs;
  return (
    <section className="strategy-target-cockpit">
      <header>
        <div>
          {binding.targetType === "BROKER_ACCOUNT" ? (
            <WalletCards size={16} />
          ) : (
            <Users size={16} />
          )}
          <span>
            SELECTED TARGET COCKPIT · TARGET{" "}
            {String(binding.slotIndex).padStart(2, "0")}
          </span>
          <strong>{binding.targetType.replaceAll("_", " ")}</strong>
        </div>
        <StatusBadge
          value={`${binding.status} · ${snapshot?.freshness || "UNAVAILABLE"}`}
        />
      </header>
      <div className="strategy-cockpit-metrics">
        <Metric label="Equity" value={money(snapshot?.equity)} />
        <Metric label="Wallet balance" value={money(snapshot?.walletBalance)} />
        <Metric label="Available" value={money(snapshot?.availableBalance)} />
        <Metric
          label="Allocated capital"
          value={money(snapshot?.allocatedStrategyCapital)}
        />
        <Metric
          label="Used capital"
          value={money(snapshot?.usedStrategyCapital)}
        />
        <Metric
          label="Free capital"
          value={money(snapshot?.freeStrategyCapital)}
        />
        <Metric label="Margin used" value={money(snapshot?.marginUsed)} />
        <Metric
          label="Margin utilization"
          value={`${(snapshot?.marginUtilization || 0).toFixed(2)}%`}
        />
        <Metric
          label="Realized PnL"
          value={money(snapshot?.realizedPnl)}
          signed
        />
        <Metric
          label="Unrealized PnL"
          value={money(snapshot?.unrealizedPnl)}
          signed
        />
        <Metric label="Gross PnL" value={money(snapshot?.grossPnl)} signed />
        <Metric label="Fees" value={money(-(snapshot?.fees || 0))} signed />
        <Metric label="Funding" value={money(snapshot?.funding)} signed />
        <Metric label="Net PnL" value={money(snapshot?.netPnl)} signed />
        <Metric
          label="Return"
          value={`${(snapshot?.returnPercent || 0).toFixed(2)}%`}
          signed
        />
        <Metric
          label="Open positions"
          value={String(snapshot?.openPositions || 0)}
        />
        <Metric label="Open orders" value={String(snapshot?.openOrders || 0)} />
        <Metric
          label="Requested leverage"
          value={
            binding.marketType === "SPOT"
              ? "SPOT — UNLEVERAGED"
              : `${snapshot?.requestedLeverage || 1}x`
          }
        />
        <Metric
          label="Effective leverage"
          value={
            binding.marketType === "SPOT"
              ? "SPOT — UNLEVERAGED"
              : `${snapshot?.effectiveLeverage || 1}x`
          }
        />
        <Metric
          label="Current drawdown"
          value={`${(snapshot?.currentDrawdownPercent || 0).toFixed(2)}%`}
        />
        <Metric
          label="Maximum drawdown"
          value={`${(snapshot?.maximumDrawdownPercent || 0).toFixed(2)}%`}
        />
        <Metric
          label="Win rate"
          value={`${(snapshot?.winRate || 0).toFixed(1)}%`}
        />
        <Metric
          label="Profit factor"
          value={
            snapshot?.profitFactor == null
              ? "—"
              : snapshot.profitFactor.toFixed(2)
          }
        />
        <Metric label="Sharpe" value={(snapshot?.sharpe || 0).toFixed(2)} />
        <Metric label="Sortino" value={(snapshot?.sortino || 0).toFixed(2)} />
        <Metric label="Calmar" value={(snapshot?.calmar || 0).toFixed(2)} />
        <Metric label="Trade count" value={String(snapshot?.tradeCount || 0)} />
        {binding.targetType === "INVESTMENT_GROUP" && (
          <>
            <Metric label="Members" value={String(snapshot?.members || 0)} />
            <Metric
              label="Eligible members"
              value={String(snapshot?.eligibleMembers || 0)}
            />
            <Metric
              label="Paused members"
              value={String(snapshot?.pausedMembers || 0)}
            />
            <Metric
              label="Degraded members"
              value={String(snapshot?.degradedMembers || 0)}
            />
            <Metric
              label="Effective member range"
              value={
                snapshot?.effectiveLeverageRange
                  ? `${snapshot.effectiveLeverageRange[0]}x–${snapshot.effectiveLeverageRange[1]}x`
                  : "UNAVAILABLE"
              }
            />
          </>
        )}
        <Metric
          label="Protection"
          value={snapshot?.protectionHealth || "UNAVAILABLE"}
        />
      </div>
      <nav className="strategy-cockpit-tabs">
        {targetTabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            className={resource === tab.id ? "active" : ""}
            onClick={() => onResource(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {resource === "overview" ? (
        <div className="strategy-cockpit-runtime">
          <span>
            Connection health{" "}
            <b>{snapshot?.connectionHealth || "UNAVAILABLE"}</b>
          </span>
          <span>
            Freshness <b>{snapshot?.freshness || "UNAVAILABLE"}</b>
          </span>
          <span>
            Realized PnL <b>{money(snapshot?.realizedPnl)}</b>
          </span>
          <span>
            Unrealized PnL <b>{money(snapshot?.unrealizedPnl)}</b>
          </span>
          <span>
            Win rate <b>{(snapshot?.winRate || 0).toFixed(1)}%</b>
          </span>
          <span>
            Sharpe <b>{(snapshot?.sharpe || 0).toFixed(2)}</b>
          </span>
        </div>
      ) : (
        <ResourceTable payload={payload} />
      )}
    </section>
  );
}

function ResourceTable({ payload }: { payload: unknown }) {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? [payload]
      : [];
  if (!rows.length)
    return (
      <div className="strategy-resource-empty">
        NO STRATEGY-OWNED RECORDS FOR THIS TARGET.
      </div>
    );
  const keys = Object.keys(rows[0] as Record<string, unknown>)
    .filter((key) => !key.includes("raw") && !key.includes("metadata"))
    .slice(0, 10);
  return (
    <div className="strategy-resource-table-wrap">
      <table>
        <thead>
          <tr>
            {keys.map((key) => (
              <th key={key}>{key.replaceAll("_", " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 250).map((row, index) => (
            <tr key={String((row as any).id || index)}>
              {keys.map((key) => (
                <td key={key}>{formatCell((row as any)[key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddTargetDialog({
  slotIndex,
  activeTab,
  eligible,
  busy,
  onTab,
  onAdd,
  onClose,
}: {
  slotIndex: number;
  activeTab: "broker" | "group";
  eligible: {
    brokerAccounts: EligibleBrokerTarget[];
    groups: EligibleGroupTarget[];
  } | null;
  busy: boolean;
  onTab: (tab: "broker" | "group") => void;
  onAdd: (target: EligibleBrokerTarget | EligibleGroupTarget) => void;
  onClose: () => void;
}) {
  const targets =
    activeTab === "broker"
      ? eligible?.brokerAccounts || []
      : eligible?.groups || [];
  return (
    <div className="strategy-modal-backdrop">
      <section className="strategy-target-dialog">
        <header>
          <div>
            <Plus size={16} />
            <span>ADD STRATEGY TARGET</span>
            <strong>TARGET {String(slotIndex).padStart(2, "0")}</strong>
          </div>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <nav>
          <button
            type="button"
            className={activeTab === "broker" ? "active" : ""}
            onClick={() => onTab("broker")}
          >
            <WalletCards size={14} /> BROKER ACCOUNTS
          </button>
          <button
            type="button"
            className={activeTab === "group" ? "active" : ""}
            onClick={() => onTab("group")}
          >
            <Users size={14} /> MY INVESTMENT GROUP
          </button>
        </nav>
        <div className="strategy-target-options">
          {!eligible ? (
            <div className="strategy-resource-empty">
              <RefreshCw size={16} className="spin" /> VALIDATING AUTHORIZED
              TARGETS
            </div>
          ) : targets.length === 0 ? (
            <div className="strategy-resource-empty">
              NO MANAGED, ELIGIBLE TARGETS ARE AVAILABLE.
            </div>
          ) : (
            targets.map((target) => (
              <button
                type="button"
                key={target.targetId}
                disabled={busy || !target.validation.eligible}
                className={target.validation.eligible ? "eligible" : "blocked"}
                onClick={() => onAdd(target)}
              >
                <div>
                  <strong>{target.label}</strong>
                  <span>
                    {target.targetType === "BROKER_ACCOUNT"
                      ? `${target.provider} · ${target.environment}`
                      : "MY INVESTMENT GROUP"}
                  </span>
                </div>
                {target.targetType === "BROKER_ACCOUNT" ? (
                  <>
                    <Metric label="Equity" value={money(target.equity)} />
                    <Metric
                      label="Available"
                      value={money(target.availableBalance)}
                    />
                    <Metric
                      label="Private stream"
                      value={target.privateStreamHealth}
                    />
                    <Metric
                      label="Reconciliation"
                      value={target.reconciliationStatus}
                    />
                  </>
                ) : (
                  <>
                    <Metric
                      label="Authorized members"
                      value={String(target.activeAuthorizedMembers)}
                    />
                    <Metric
                      label="Allocated equity"
                      value={money(target.connectedAllocatedEquity)}
                    />
                    <Metric
                      label="Black Cloud"
                      value={target.blackCloudReadiness}
                    />
                    <Metric label="Risk state" value={target.riskState} />
                  </>
                )}
                <footer>
                  {target.validation.eligible ? (
                    <>
                      <ShieldCheck size={13} /> ELIGIBLE — ADD WITH 0%
                      ALLOCATION
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={13} />{" "}
                      {target.validation.reasons.join(" · ")}
                    </>
                  )}
                </footer>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function CapitalPolicyDrawer({
  editor,
  busy,
  onSave,
  onClose,
}: {
  editor: CapitalEditor;
  busy: boolean;
  onSave: (policy: StrategyCapitalPolicy) => void;
  onClose: () => void;
}) {
  const source =
    editor.kind === "paper"
      ? editor.paper.capitalPolicy
      : editor.binding.capitalPolicy;
  const marketType =
    editor.kind === "paper"
      ? editor.paper.marketType
      : editor.binding.marketType;
  const [policy, setPolicy] = useState<StrategyCapitalPolicy>({ ...source });
  const update = <K extends keyof StrategyCapitalPolicy>(
    key: K,
    value: StrategyCapitalPolicy[K],
  ) => setPolicy((current) => ({ ...current, [key]: value }));
  const preview = capitalPreviewForPolicy(
    policy,
    marketType,
    editor.kind === "paper"
      ? editor.paper.demoEquity
      : editor.snapshot?.equity || 0,
    editor.kind === "paper"
      ? editor.paper.availableBalance
      : editor.snapshot?.availableBalance || 0,
  );
  return (
    <div className="strategy-modal-backdrop drawer">
      <section className="strategy-capital-drawer">
        <header>
          <div>
            <CircleDollarSign size={16} />
            <span>CAPITAL & RISK</span>
            <strong>
              {editor.kind === "paper"
                ? "PAPER TARGET"
                : `TARGET ${String(editor.binding.slotIndex).padStart(2, "0")}`}
            </strong>
          </div>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="strategy-capital-warning">
          <ShieldCheck size={15} />
          <span>Percentage always means a direct portion of capital.</span>
        </div>
        <div className="strategy-capital-fields">
          <label>
            Strategy Allocation Mode
            <select
              value={policy.strategyAllocationMode}
              onChange={(event) =>
                update(
                  "strategyAllocationMode",
                  event.target
                    .value as StrategyCapitalPolicy["strategyAllocationMode"],
                )
              }
            >
              <option value="PERCENT_ACCOUNT_EQUITY">
                Percentage of Account Equity
              </option>
              <option value="FIXED_USDT">Fixed USDT Amount</option>
            </select>
          </label>
          <label>
            Strategy Allocation
            <input
              type="number"
              min={0}
              max={
                policy.strategyAllocationMode === "PERCENT_ACCOUNT_EQUITY"
                  ? 100
                  : undefined
              }
              step="0.1"
              value={policy.strategyAllocationValue}
              onChange={(event) =>
                update("strategyAllocationValue", Number(event.target.value))
              }
            />
            <em>
              {policy.strategyAllocationMode === "PERCENT_ACCOUNT_EQUITY"
                ? "% OF ACCOUNT EQUITY"
                : "USDT"}
            </em>
          </label>
          <label>
            Trade Amount Mode
            <select
              value={policy.tradeAmountMode}
              onChange={(event) =>
                update(
                  "tradeAmountMode",
                  event.target
                    .value as StrategyCapitalPolicy["tradeAmountMode"],
                )
              }
            >
              <option value="PERCENT_ACCOUNT_EQUITY">
                Percentage of Account Equity
              </option>
              <option value="PERCENT_STRATEGY_ALLOCATION">
                Percentage of Strategy Allocation
              </option>
              <option value="RISK_PERCENT">Risk Percentage Per Trade</option>
              <option value="FIXED_USDT">Fixed USDT Amount</option>
              <option value="FIXED_QUANTITY">Fixed Quantity</option>
              <option value="VOLATILITY_TARGET">Volatility Target</option>
            </select>
          </label>
          <label>
            Per-Trade Amount
            <input
              type="number"
              min={0}
              step="0.1"
              value={policy.tradeAmountValue}
              onChange={(event) =>
                update("tradeAmountValue", Number(event.target.value))
              }
            />
            <em>
              {policy.tradeAmountMode === "FIXED_USDT"
                ? "USDT"
                : policy.tradeAmountMode === "FIXED_QUANTITY"
                  ? "UNITS"
                  : policy.tradeAmountMode === "VOLATILITY_TARGET"
                    ? "% RISK BUDGET"
                    : "%"}
            </em>
          </label>
          {marketType === "FUTURES" ? (
            <>
              <label>
                Requested Leverage
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step="0.1"
                  value={policy.requestedLeverage || 1}
                  onChange={(event) =>
                    update("requestedLeverage", Number(event.target.value))
                  }
                />
              </label>
              <label>
                Maximum Allowed Leverage
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step="0.1"
                  value={policy.maximumLeverage || 1}
                  onChange={(event) =>
                    update("maximumLeverage", Number(event.target.value))
                  }
                />
              </label>
              <label>
                Margin Mode
                <select
                  value={policy.marginMode || "CROSS"}
                  onChange={(event) =>
                    update(
                      "marginMode",
                      event.target.value as "CROSS" | "ISOLATED",
                    )
                  }
                >
                  <option value="CROSS">Cross</option>
                  <option value="ISOLATED">Isolated</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <div className="strategy-spot-unleveraged">
                SPOT — UNLEVERAGED
              </div>
              <label>
                Quote Asset Reserve
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={policy.quoteAssetReservePercent || 0}
                  onChange={(event) =>
                    update(
                      "quoteAssetReservePercent",
                      Number(event.target.value),
                    )
                  }
                />
                <em>% OF EQUITY</em>
              </label>
              <label>
                Maximum Base-Asset Exposure
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={policy.maximumBaseAssetExposurePercent || 0}
                  onChange={(event) =>
                    update(
                      "maximumBaseAssetExposurePercent",
                      Number(event.target.value),
                    )
                  }
                />
                <em>% OF STRATEGY CAPITAL</em>
              </label>
            </>
          )}
          <label>
            Maximum Position Size
            <input
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={policy.maximumPositionPercent}
              onChange={(event) =>
                update("maximumPositionPercent", Number(event.target.value))
              }
            />
            <em>% OF STRATEGY CAPITAL</em>
          </label>
          <label>
            Maximum Total Exposure
            <input
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={policy.maximumExposurePercent}
              onChange={(event) =>
                update("maximumExposurePercent", Number(event.target.value))
              }
            />
            <em>%</em>
          </label>
          <label>
            Maximum Daily Loss
            <input
              type="number"
              min={0}
              step="1"
              value={policy.maximumDailyLoss}
              onChange={(event) =>
                update("maximumDailyLoss", Number(event.target.value))
              }
            />
            <em>USDT</em>
          </label>
          <label>
            Maximum Drawdown
            <input
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={policy.maximumDrawdown}
              onChange={(event) =>
                update("maximumDrawdown", Number(event.target.value))
              }
            />
            <em>%</em>
          </label>
          <label>
            Maximum Positions
            <input
              type="number"
              min={1}
              max={1000}
              value={policy.maximumPositions}
              onChange={(event) =>
                update("maximumPositions", Number(event.target.value))
              }
            />
          </label>
          <label>
            Slippage Limit
            <input
              type="number"
              min={0}
              max={10000}
              step="0.1"
              value={policy.slippageBps}
              onChange={(event) =>
                update("slippageBps", Number(event.target.value))
              }
            />
            <em>BPS</em>
          </label>
        </div>
        <div className="strategy-capital-preview">
          <Metric label="Current equity" value={money(preview.equity)} />
          <Metric
            label="Strategy allocation"
            value={money(preview.allocatedStrategyCapital)}
          />
          <Metric
            label="Available strategy capital"
            value={money(preview.availableStrategyCapital)}
          />
          <Metric
            label="Per-entry capital"
            value={
              preview.dynamicSizing
                ? "DYNAMIC AT SIGNAL"
                : money(preview.entryCapital)
            }
          />
          <Metric
            label="Requested leverage"
            value={
              marketType === "SPOT"
                ? "SPOT — UNLEVERAGED"
                : `${policy.requestedLeverage || 1}x`
            }
          />
          <Metric
            label="Effective leverage"
            value={
              marketType === "SPOT"
                ? "SPOT — UNLEVERAGED"
                : `${preview.effectiveLeverage}x`
            }
          />
          <Metric
            label="Estimated notional"
            value={
              preview.dynamicSizing
                ? "FINALIZED AT SIGNAL"
                : money(preview.estimatedNotional)
            }
          />
          <Metric
            label="Estimated margin"
            value={
              preview.dynamicSizing
                ? "FINALIZED AT SIGNAL"
                : money(preview.estimatedMargin)
            }
          />
          <Metric
            label="Maximum configured loss"
            value={money(policy.maximumDailyLoss)}
          />
          <Metric
            label="Remaining reserve"
            value={money(preview.remainingReserve)}
          />
        </div>
        {editor.kind === "target" && policy.strategyAllocationValue === 0 && (
          <div className="strategy-live-zero">
            <AlertTriangle size={14} /> LIVE TARGET REMAINS NOT ARMED WHILE
            ALLOCATION IS 0%.
          </div>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            CANCEL
          </button>
          <button type="button" disabled={busy} onClick={() => onSave(policy)}>
            <Save size={13} /> SAVE POLICY VERSION
          </button>
        </footer>
      </section>
    </div>
  );
}

function PaperFundsDialog({
  action,
  paper,
  busy,
  onConfirm,
  onClose,
}: {
  action: "top-up" | "reset";
  paper: StrategyPaperAccount;
  busy: boolean;
  onConfirm: (amount: number) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(10_000);
  const valid =
    Number.isFinite(amount) && amount > 0 && amount <= 1_000_000_000;
  const reset = action === "reset";
  return (
    <div className="strategy-modal-backdrop">
      <section className="strategy-disconnect-dialog strategy-paper-funds-dialog">
        <header>
          <div>
            {reset ? <RefreshCw size={16} /> : <Plus size={16} />}
            <span>{reset ? "RESET PAPER ACCOUNT" : "TOP UP DEMO EQUITY"}</span>
            <strong>{paper.marketType} PAPER TARGET</strong>
          </div>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p>
          {reset
            ? "Reset requires no open paper position. It clears virtual PnL, fees, funding and drawdown history for the active paper account version; immutable execution and trade records remain preserved."
            : "This adds virtual capital only. It never transfers funds and never changes a connected broker account."}
        </p>
        <label>
          {reset ? "New demo equity" : "Top-up amount"}
          <input
            type="number"
            min={1}
            max={1_000_000_000}
            step={100}
            value={amount}
            onChange={(event) => setAmount(Number(event.target.value))}
          />
          <em>USDT</em>
        </label>
        <div className="strategy-capital-preview">
          <Metric label="Current demo equity" value={money(paper.demoEquity)} />
          <Metric
            label={reset ? "Reset demo equity" : "Equity after top-up"}
            value={money(reset ? amount : paper.demoEquity + amount)}
          />
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            CANCEL
          </button>
          <button
            type="button"
            disabled={busy || !valid}
            onClick={() => onConfirm(amount)}
          >
            {reset ? "RESET PAPER ACCOUNT" : "TOP UP DEMO EQUITY"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function DisconnectDialog({
  binding,
  busy,
  onConfirm,
  onClose,
}: {
  binding: StrategyTargetBinding;
  busy: boolean;
  onConfirm: (policy: string) => void;
  onClose: () => void;
}) {
  const [policy, setPolicy] = useState("DETACH_MANUAL");
  return (
    <div className="strategy-modal-backdrop">
      <section className="strategy-disconnect-dialog">
        <header>
          <div>
            <Unplug size={16} />
            <span>DISCONNECT TARGET</span>
            <strong>TARGET {String(binding.slotIndex).padStart(2, "0")}</strong>
          </div>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p>
          Future strategy signals stop after binding revocation. The broker
          connection remains in Positions and historical strategy records remain
          available.
        </p>
        <label>
          Open-position policy
          <select
            value={policy}
            onChange={(event) => setPolicy(event.target.value)}
          >
            <option value="DETACH_MANUAL">
              Detach and manage positions manually
            </option>
            <option value="CLOSE_STRATEGY_POSITIONS">
              Close strategy-owned positions
            </option>
            <option value="KEEP_PROTECTED">
              Keep strategy-owned positions protected
            </option>
            <option value="DISCONNECT_WHEN_FLAT">Disconnect when flat</option>
          </select>
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            CANCEL
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm(policy)}
          >
            DISCONNECT TARGET
          </button>
        </footer>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  signed = false,
}: {
  label: string;
  value: string;
  signed?: boolean;
}) {
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ""));
  const tone =
    signed && Number.isFinite(numeric)
      ? numeric > 0
        ? "positive"
        : numeric < 0
          ? "negative"
          : "neutral"
      : "";
  return (
    <div className="strategy-metric">
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  return (
    <b
      className={`strategy-status-badge ${/LIVE|ACTIVE|READY/.test(value) ? "positive" : /ERROR|SUSPENDED/.test(value) ? "negative" : "neutral"}`}
    >
      {value}
    </b>
  );
}
function money(value?: number) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(value))
    : "$0.00";
}
function relative(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 1000),
  );
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`;
}
function formatCell(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number")
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4);
  if (typeof value === "object") return JSON.stringify(value).slice(0, 120);
  return String(value);
}
function policyAmount(mode: string, value: number) {
  return mode === "FIXED_USDT"
    ? money(value)
    : mode === "FIXED_QUANTITY"
      ? `${value} UNITS`
      : `${value}%`;
}

function capitalPreviewForPolicy(
  policy: StrategyCapitalPolicy,
  marketType: "SPOT" | "FUTURES",
  rawEquity: number,
  rawAvailable: number,
) {
  const equity = Math.max(0, Number(rawEquity) || 0);
  const available = Math.max(0, Number(rawAvailable) || 0);
  const allocatedStrategyCapital =
    policy.strategyAllocationMode === "FIXED_USDT"
      ? Math.min(equity, policy.strategyAllocationValue)
      : (equity * policy.strategyAllocationValue) / 100;
  const quoteReserve =
    marketType === "SPOT"
      ? (equity * (policy.quoteAssetReservePercent || 0)) / 100
      : 0;
  const availableStrategyCapital = Math.max(
    0,
    Math.min(allocatedStrategyCapital, available - quoteReserve),
  );
  const dynamicSizing = ["FIXED_QUANTITY", "VOLATILITY_TARGET"].includes(
    policy.tradeAmountMode,
  );
  let entryCapital = 0;
  if (policy.tradeAmountMode === "PERCENT_ACCOUNT_EQUITY")
    entryCapital = (equity * policy.tradeAmountValue) / 100;
  else if (
    [
      "PERCENT_STRATEGY_ALLOCATION",
      "RISK_PERCENT",
      "VOLATILITY_TARGET",
    ].includes(policy.tradeAmountMode)
  )
    entryCapital = (allocatedStrategyCapital * policy.tradeAmountValue) / 100;
  else if (policy.tradeAmountMode === "FIXED_USDT")
    entryCapital = policy.tradeAmountValue;
  entryCapital = Math.max(
    0,
    Math.min(entryCapital, allocatedStrategyCapital, availableStrategyCapital),
  );
  const effectiveLeverage =
    marketType === "SPOT"
      ? 1
      : Math.max(
          1,
          Math.min(
            policy.requestedLeverage || 1,
            policy.maximumLeverage || policy.requestedLeverage || 1,
          ),
        );
  const estimatedNotional =
    marketType === "SPOT" ? entryCapital : entryCapital * effectiveLeverage;
  return {
    equity,
    allocatedStrategyCapital,
    availableStrategyCapital,
    entryCapital,
    effectiveLeverage,
    estimatedNotional,
    estimatedMargin: entryCapital,
    remainingReserve: Math.max(0, allocatedStrategyCapital - entryCapital),
    dynamicSizing,
  };
}
