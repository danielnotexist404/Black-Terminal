import { ChevronDown, LockKeyhole, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CompiledScriptInput, ScriptInputValue } from "../../../../components/ScriptCompiler";
import type { StrategyAutomationDefinition, StrategyCapitalPolicy, StrategyControlPanel, StrategyTargetBinding, StrategyWorkspace } from "../../automation/strategyAutomation.types";
import { PaperCockpit } from "../cockpit/PaperCockpit";
import { RuntimeTimeline } from "../cockpit/RuntimeTimeline";
import { StrategyHeader } from "../cockpit/StrategyHeader";
import { StrategyOverview } from "../cockpit/StrategyOverview";
import { TargetSlotMatrix } from "../cockpit/TargetSlotMatrix";
import { TargetCockpit } from "../cockpit/TargetCockpit";
import { StrategyExecutionDesk } from "../../execution-desk/StrategyExecutionDesk";
import { StrategyControlPanelDialog } from "../../execution-desk/StrategyControlPanelDialog";
import { readStrategyControlPanel } from "../../execution-desk/strategyControlPanelModel";
import { paperStrategyDestinationKey, preferredStrategyDestination, resolveStrategyDestination, selectableStrategyBindings } from "../../execution-desk/strategyDestinationModel";

export type CockpitTab = "overview" | "executionDesk" | "strategySettings" | "configuration" | "paper" | "liveTargets" | "positions" | "trades" | "performance" | "risk" | "logs";
const tabs: Array<[CockpitTab, string]> = [["overview", "OVERVIEW"], ["executionDesk", "EXECUTION DESK"], ["strategySettings", "STRATEGY SETTINGS"], ["configuration", "CONFIGURATION"], ["paper", "PAPER"], ["liveTargets", "LIVE TARGETS"], ["positions", "POSITIONS"], ["trades", "TRADES"], ["performance", "PERFORMANCE"], ["risk", "RISK"], ["logs", "LOGS"]];

type Props = {
  workspace: StrategyWorkspace;
  paperData: Record<string, unknown> | null;
  busy: boolean;
  message?: string;
  onEdit: () => void;
  onRefresh: () => void;
  onPaperAction: (action: "start" | "pause" | "top-up" | "reset", body?: Record<string, unknown>) => void;
  onAddTarget: (slotIndex: number) => void;
  onModifyTarget: (binding: StrategyTargetBinding) => void;
  onTargetAction: (bindingId: string, action: "arm" | "pause" | "resume") => void;
  onDisconnectTarget: (bindingId: string) => void;
  onApplyExecutionConfiguration: (definition: StrategyAutomationDefinition, policy: StrategyCapitalPolicy, sourceKey: string, panel: StrategyControlPanel, nativeSettings?: Record<string, unknown>) => Promise<void>;
};

export function StrategyCockpitPage(props: Props) {
  const [activeTab, setActiveTab] = useState<CockpitTab>("overview");
  const [advancedLogs, setAdvancedLogs] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(props.workspace.bindings[0]?.id || null);
  const paperRows = useMemo(() => ({ positions: list(props.paperData?.positions), trades: list(props.paperData?.trades), orders: list(props.paperData?.orders), analytics: object(props.paperData?.analytics) }), [props.paperData]);
  return <section className="strategy-cockpit">
    <StrategyHeader workspace={props.workspace} busy={props.busy} onEdit={props.onEdit} onPaperAction={(action) => props.onPaperAction(action)} />
    <nav className="strategy-cockpit-tabs" aria-label="Strategy cockpit sections">{tabs.map(([id, label]) => <button key={id} type="button" className={activeTab === id ? "active" : ""} onClick={() => setActiveTab(id)}>{label}</button>)}<button type="button" className="refresh" aria-label="Refresh strategy state" onClick={props.onRefresh}><RefreshCw size={12} /></button></nav>
    {props.message ? <div className="strategy-cockpit-message" role="status">{props.message}</div> : null}
    <div className="strategy-cockpit-body">
      {activeTab === "overview" ? <StrategyOverview workspace={props.workspace} paperData={props.paperData} onAddTarget={props.onAddTarget} /> : null}
      {activeTab === "executionDesk" ? <StrategyExecutionDesk workspace={props.workspace} paperData={props.paperData} busy={props.busy} onApplyConfiguration={props.onApplyExecutionConfiguration} /> : null}
      {activeTab === "strategySettings" ? <StrategySettings workspace={props.workspace} busy={props.busy} onApply={props.onApplyExecutionConfiguration} /> : null}
      {activeTab === "configuration" ? <Configuration workspace={props.workspace} onEdit={props.onEdit} /> : null}
      {activeTab === "paper" ? <PaperCockpit paper={props.workspace.paper} data={props.paperData} busy={props.busy} onAction={props.onPaperAction} /> : null}
      {activeTab === "liveTargets" ? <><TargetSlotMatrix bindings={props.workspace.bindings} snapshots={props.workspace.snapshots} selectedId={selectedTargetId} onSelect={setSelectedTargetId} onAdd={props.onAddTarget} />{selectedTargetId && props.workspace.bindings.find((item) => item.id === selectedTargetId) ? <TargetCockpit binding={props.workspace.bindings.find((item) => item.id === selectedTargetId)!} snapshot={props.workspace.snapshots.find((item) => item.bindingId === selectedTargetId)} busy={props.busy} onAction={(action) => props.onTargetAction(selectedTargetId, action)} onModify={() => props.onModifyTarget(props.workspace.bindings.find((item) => item.id === selectedTargetId)!)} onDisconnect={() => props.onDisconnectTarget(selectedTargetId)} /> : <div className="live-certification-banner"><LockKeyhole size={14} /><div><strong>NO EXECUTION DESTINATION ASSIGNED</strong><span>Add an eligible connected broker account or an owned Investment Group, review its risk policy, and arm it explicitly.</span></div></div>}</> : null}
      {activeTab === "positions" ? <DataTable kind="positions" rows={paperRows.positions} /> : null}
      {activeTab === "trades" ? <DataTable kind="trades" rows={paperRows.trades} /> : null}
      {activeTab === "performance" ? <Performance analytics={paperRows.analytics} trades={paperRows.trades} /> : null}
      {activeTab === "risk" ? <Risk workspace={props.workspace} analytics={paperRows.analytics} /> : null}
      {activeTab === "logs" ? <section className="cockpit-panel"><header><span>RUNTIME LOGS</span><button type="button" onClick={() => setAdvancedLogs((value) => !value)}>{advancedLogs ? "HIDE" : "SHOW"} ADVANCED DIAGNOSTICS <ChevronDown size={11} /></button></header><RuntimeTimeline audit={props.workspace.audit} advanced={advancedLogs} /></section> : null}
    </div>
  </section>;
}

function StrategySettings({ workspace, busy, onApply }: { workspace: StrategyWorkspace; busy: boolean; onApply: Props["onApplyExecutionConfiguration"] }) {
  const definition = workspace.strategy.draftDefinition || workspace.strategy.definition;
  const bindings = useMemo(() => selectableStrategyBindings(workspace.bindings), [workspace.bindings]);
  const preferredSourceKey = preferredStrategyDestination(bindings, workspace.strategy.definition.deployment);
  const [sourceKey, setSourceKey] = useState(preferredSourceKey);
  const manuallySelectedSource = useRef(false);
  useEffect(() => {
    manuallySelectedSource.current = false;
    setSourceKey(preferredStrategyDestination(bindings, workspace.strategy.definition.deployment));
  }, [workspace.strategy.id]);
  useEffect(() => {
    const resolved = resolveStrategyDestination(sourceKey, bindings, workspace.strategy.definition.deployment);
    if (resolved.key !== sourceKey || (!manuallySelectedSource.current && sourceKey === paperStrategyDestinationKey && preferredSourceKey !== paperStrategyDestinationKey)) setSourceKey(resolved.key === sourceKey ? preferredSourceKey : resolved.key);
  }, [bindings, preferredSourceKey, sourceKey, workspace.strategy.definition.deployment]);
  const binding = bindings.find((item) => item.id === sourceKey);
  const snapshot = binding ? workspace.snapshots.find((item) => item.bindingId === binding.id) : undefined;
  const policy = binding?.capitalPolicy || workspace.paper?.capitalPolicy || workspace.strategy.globalCapitalPolicy;
  const accountLabel = binding ? `${String(binding.slotIndex).padStart(2, "0")} · ${binding.targetLabel || binding.targetProvider || binding.targetType}` : "Default strategy policy / Paper";
  const accountEquity = binding ? snapshot?.equity : workspace.paper?.demoEquity;
  const nativeInputs = definition.runtimeKind === "builtin-superatr-seven-step" ? [] : strategyNativeInputs(definition);
  const panel = readStrategyControlPanel(definition, policy, accountEquity, true);
  return <section className="strategy-settings-page">
    <header><div><span>DYNAMIC SCRIPT CONTRACT</span><h2>{definition.indicator?.name || workspace.strategy.name}</h2><p>Inputs come from this strategy's own script declaration. Select a destination to edit the percentage sizing and per-trade leverage that its execution worker will enforce.</p><label className="strategy-settings-source"><b>SETTINGS DESTINATION</b><select value={sourceKey} onChange={(event) => { manuallySelectedSource.current = true; setSourceKey(event.target.value); }}><option value={paperStrategyDestinationKey}>PAPER TRADE ACCOUNT · SIMULATED CAPITAL</option>{bindings.map((item) => <option key={item.id} value={item.id}>{String(item.slotIndex).padStart(2, "0")} · {item.targetLabel || item.targetProvider || item.targetType} · API EQUITY</option>)}</select></label></div><strong>{workspace.strategy.hasDraftChanges ? "DRAFT CHANGES PENDING" : `SAVED V${workspace.strategy.publishedVersion || "—"}`}</strong></header>
    <StrategyControlPanelDialog embedded name={workspace.strategy.name} accountLabel={accountLabel} initial={panel} initialSettings={definition.settings as Record<string, unknown>} nativeInputs={nativeInputs} sourceKey={sourceKey} authoritativeDestination={Boolean(binding)} authoritativeEquity={binding ? snapshot?.equity : undefined} authoritativeAvailableBalance={binding ? snapshot?.availableBalance : undefined} authoritativeEquityTimestamp={binding ? snapshot?.timestamp : undefined} authoritativeFreshness={binding ? snapshot?.freshness : undefined} busy={busy} onCancel={() => undefined} onApply={(nextPanel, nativeSettings) => onApply(definition, policy, sourceKey, nextPanel, nativeSettings)} />
    <div className="strategy-settings-isolation"><LockKeyhole size={13} /><span>Saving here never loads the strategy onto the discretionary chart and never arms a broker. Existing live targets keep their currently approved immutable version until explicitly migrated.</span></div>
  </section>;
}

function strategyNativeInputs(definition: StrategyAutomationDefinition): CompiledScriptInput[] {
  const settings = definition.settings as Record<string, unknown>;
  const stored = settings.__nativeInputs;
  if (Array.isArray(stored)) {
    const parsed = stored.flatMap((value): CompiledScriptInput[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Partial<CompiledScriptInput>;
      if (typeof row.key !== "string" || typeof row.variable !== "string" || typeof row.label !== "string" || !["int", "float", "bool", "string", "color"].includes(String(row.type))) return [];
      if (!["number", "boolean", "string"].includes(typeof row.defaultValue)) return [];
      return [{ ...row, type: row.type as CompiledScriptInput["type"], defaultValue: row.defaultValue as ScriptInputValue } as CompiledScriptInput];
    });
    if (parsed.length) return parsed;
  }
  return Object.entries(settings).flatMap(([key, value]): CompiledScriptInput[] => {
    if (key.startsWith("__") || !["number", "boolean", "string"].includes(typeof value)) return [];
    const type = typeof value === "boolean" ? "bool" : typeof value === "number" ? (Number.isInteger(value) ? "int" : "float") : /^#[0-9a-f]{6}$/i.test(String(value)) ? "color" : "string";
    return [{ key, variable: key, label: humanizeSetting(key), type, defaultValue: value as ScriptInputValue }];
  });
}

function humanizeSetting(value: string) { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function Configuration({ workspace, onEdit }: { workspace: StrategyWorkspace; onEdit: () => void }) {
  const definition = workspace.strategy.definition;
  const sections: Array<[string, Array<[string, string]>]> = [
    ["Indicator", [["Instance", definition.indicator?.instanceName || definition.indicator?.name || "—"], ["Version", definition.indicator?.version || "—"], ["Runtime", definition.indicator?.runtimeStatus || "—"], ["Settings", definition.indicator?.settingsSummary || "—"]]],
    ["Market", [["Exchange", definition.exchange.toUpperCase()], ["Symbol", definition.symbol], ["Timeframe", definition.timeframe.toUpperCase()], ["Type", definition.marketType]]],
    ["Signals", entries(definition.signals)], ["Execution", entries(definition.execution)], ["Risk", entries(workspace.strategy.globalCapitalPolicy)], ["Filters", entries(definition.filters)], ["Exits", entries(definition.exits)], ["Targets", [["Paper", workspace.paper ? workspace.paper.status : "Not created"], ["Live", `${workspace.bindings.length} / 9 · locked`]]],
  ];
  return <div className="configuration-sections"><header><div><span>CURRENT CONFIGURATION</span><h2>Published V{workspace.strategy.publishedVersion || "—"} · Running V{workspace.strategy.runningVersion || "—"}</h2></div><button type="button" onClick={onEdit}>EDIT DRAFT</button></header>{sections.map(([title, rows], index) => <details key={title} open={index < 3}><summary>{title}<span>{rows.length} settings</span></summary><div>{rows.map(([label, value]) => <p key={label}><span>{label}</span><strong>{value}</strong></p>)}</div></details>)}</div>;
}

function DataTable({ kind, rows }: { kind: "positions" | "trades"; rows: Array<Record<string, unknown>> }) {
  const [scrollTop, setScrollTop] = useState(0);
  if (!rows.length) return <div className="cockpit-empty-state"><strong>No Paper {kind}</strong><span>{kind === "positions" ? "The strategy is currently flat." : "Completed Paper trades will appear here."}</span></div>;
  const position = kind === "positions";
  const columns = position ? ["Target", "Symbol", "Side", "Size", "Entry", "Mark", "Leverage", "SL", "TP", "Unrealized PnL", "Protection"] : ["Target", "Signal", "Entry Time", "Exit Time", "Entry", "Exit", "Quantity", "Gross PnL", "Fees", "Funding", "Net PnL", "Exit Reason"];
  const virtual = rows.length > 100;
  const rowHeight = 35;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - 8) : 0;
  const end = virtual ? Math.min(rows.length, start + 48) : rows.length;
  const visible = rows.slice(start, end);
  return <div className={`cockpit-table-wrap${virtual ? " virtual" : ""}`} onScroll={virtual ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}><table className="cockpit-data-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{start ? <tr className="virtual-spacer"><td colSpan={columns.length} style={{ height: start * rowHeight }} /></tr> : null}{visible.map((row, index) => <tr key={String(row.id || start + index)}>{(position ? positionCells(row) : tradeCells(row)).map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}{end < rows.length ? <tr className="virtual-spacer"><td colSpan={columns.length} style={{ height: (rows.length - end) * rowHeight }} /></tr> : null}</tbody></table></div>;
}
function positionCells(row: Record<string, unknown>) { return ["Paper", row.symbol, row.direction || row.side, row.quantity || row.size, row.average_price || row.entry_price, row.current_price || row.mark_price, row.leverage || "1x", row.stop_loss || "—", row.take_profit || "—", signedMoney(Number(row.unrealized_pnl || 0)), row.protection_status || "Paper protected"].map(textValue); }
function tradeCells(row: Record<string, unknown>) { return ["Paper", row.signal || row.direction || row.side, row.opened_at || row.entry_time, row.closed_at || row.exit_time, row.entry_price, row.exit_price, row.quantity, signedMoney(Number(row.gross_pnl || 0)), money(Number(row.fees || 0)), money(Number(row.funding || 0)), signedMoney(Number(row.net_pnl || 0)), row.exit_reason || "—"].map(textValue); }
function Performance({ analytics, trades }: { analytics: Record<string, unknown>; trades: Array<Record<string, unknown>> }) { return <div className="performance-layout"><div className="cockpit-metric-grid"><Metric label="NET PNL" value={signedMoney(Number(analytics.netPnl || 0))} /><Metric label="WIN RATE" value={`${Number(analytics.winRate || 0).toFixed(2)}%`} /><Metric label="PROFIT FACTOR" value={Number(analytics.profitFactor || 0).toFixed(2)} /><Metric label="SHARPE" value={Number(analytics.sharpe || 0).toFixed(2)} /><Metric label="SORTINO" value={Number(analytics.sortino || 0).toFixed(2)} /><Metric label="TRADES" value={String(trades.length)} /></div><section className="cockpit-panel equity-placeholder"><span>EQUITY CURVE</span><strong>{trades.length ? "Paper equity history is available after runtime snapshots." : "No Paper history yet"}</strong><p>Monthly returns, long-versus-short, fees, funding and slippage are computed from authoritative fills.</p></section></div>; }
function Risk({ workspace, analytics }: { workspace: StrategyWorkspace; analytics: Record<string, unknown> }) { const policy = workspace.paper?.capitalPolicy || workspace.strategy.globalCapitalPolicy; return <div className="risk-panel-grid"><Metric label="CURRENT DRAWDOWN" value={`${Number(analytics.currentDrawdownPercent || 0).toFixed(2)}%`} /><Metric label="MAXIMUM DRAWDOWN" value={`${policy.maximumDrawdown}%`} /><Metric label="DAILY LOSS LIMIT" value={money(policy.maximumDailyLoss)} /><Metric label="MAXIMUM EXPOSURE" value={`${policy.maximumExposurePercent}%`} /><Metric label="MAXIMUM POSITIONS" value={String(policy.maximumPositions)} /><Metric label="PROTECTION HEALTH" value={workspace.paper?.status === "RISK_SUSPENDED" ? "SUSPENDED" : "HEALTHY"} /></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function entries(value: unknown): Array<[string, string]> { const source = object(value); return Object.entries(source).slice(0, 18).map(([key, item]) => [key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()), textValue(item)]); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value as Array<Record<string, unknown>> : []; }
function textValue(value: unknown) { if (value === null || value === undefined || value === "") return "—"; if (typeof value === "object") return JSON.stringify(value); return String(value); }
function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function signedMoney(value: number) { return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
