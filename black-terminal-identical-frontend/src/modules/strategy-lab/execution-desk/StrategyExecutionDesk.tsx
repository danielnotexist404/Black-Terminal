import { Activity, BarChart3, Cloud, Crosshair, RefreshCw, Settings2, ShieldCheck, TrendingDown, TrendingUp, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlackChartEngine } from "../../../chart-engine/BlackChartEngine";
import type { Candle, VisibleIndicators } from "../../../chart-engine/types";
import type { CompiledPlot } from "../../../components/ScriptCompiler";
import { getMarketDataEngineAdapter } from "../../../market-data/engine/marketDataEngine";
import { exchangeRegistry } from "../../../market-data/exchangeRegistry";
import type { ExchangeId, MarketDataSubscription, Timeframe } from "../../../market-data/types";
import { createStrategySignals, superAtrRequiredSeedBars } from "../adapters/signalAdapter";
import { strategyAutomationApi } from "../automation/strategyAutomationApi";
import type {
  StrategyAutomationDefinition,
  StrategyCapitalPolicy,
  StrategyControlPanel,
  StrategyGroupExecutionDesk,
  StrategyPaperAccount,
  StrategyTargetBinding,
  StrategyTargetSnapshot,
  StrategyWorkspace,
} from "../automation/strategyAutomation.types";
import {
  buildExecutionDeskActions,
  buildExecutionDeskMetrics,
  equityCurve,
  executionDeskData,
  executionMarkers,
  strategySignalMarkers,
  type ExecutionDeskAction,
  type ExecutionDeskData,
  type ExecutionDeskMetrics,
} from "./executionDeskModel";
import { StrategyControlPanelDialog } from "./StrategyControlPanelDialog";
import { readStrategyControlPanel } from "./strategyControlPanelModel";

type SourceOption = {
  key: string;
  label: string;
  mode: "PAPER" | "LIVE";
  binding?: StrategyTargetBinding;
  snapshot?: StrategyTargetSnapshot | null;
  paper?: StrategyPaperAccount | null;
  data: ExecutionDeskData;
  freshness: string;
};

type DeskStrategy = {
  id: string;
  name: string;
  symbol: string;
  timeframe: string;
  exchange: string;
  marketType: "SPOT" | "FUTURES";
  runningVersion?: number | null;
  definition: StrategyAutomationDefinition;
};

const timeframeSet = new Set<Timeframe>(["1s", "10s", "30s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "3h", "4h", "6h", "8h", "12h", "1d", "1w", "1M", "1t", "10t", "100t"]);

export function StrategyExecutionDesk({ workspace, paperData, busy = false, onApplyConfiguration }: { workspace: StrategyWorkspace; paperData: Record<string, unknown> | null; busy?: boolean; onApplyConfiguration?: (definition: StrategyAutomationDefinition, policy: StrategyCapitalPolicy, sourceKey: string, panel: StrategyControlPanel) => Promise<void> }) {
  const preferredKey = preferredExecutionSource(workspace);
  const [selectedKey, setSelectedKey] = useState(preferredKey);
  const [targetData, setTargetData] = useState<Record<string, ExecutionDeskData>>({});
  const [targetError, setTargetError] = useState<string>();
  const selectedBinding = workspace.bindings.find((binding) => binding.id === selectedKey);

  const loadTarget = useCallback(async (binding: StrategyTargetBinding, signal?: AbortSignal) => {
    const resources = ["positions", "orders", "executions", "trades", "analytics"] as const;
    const responses = await Promise.all(resources.map((resource) => strategyAutomationApi.targetData<unknown>(workspace.strategy.id, binding.id, resource, signal)));
    const raw: Record<string, unknown> = {};
    resources.forEach((resource, index) => { raw[resource] = responses[index]?.[resource]; });
    setTargetData((current) => ({ ...current, [binding.id]: executionDeskData(raw) }));
    setTargetError(undefined);
  }, [workspace.strategy.id]);

  useEffect(() => {
    if (!selectedBinding) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try { await loadTarget(selectedBinding, controller.signal); }
      catch (error) { if (!controller.signal.aborted) setTargetError(error instanceof Error ? error.message : "Target execution data is unavailable."); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [loadTarget, selectedBinding]);

  useEffect(() => {
    if (selectedKey !== "paper" && !workspace.bindings.some((binding) => binding.id === selectedKey)) setSelectedKey("paper");
  }, [selectedKey, workspace.bindings]);

  useEffect(() => {
    setSelectedKey(preferredExecutionSource(workspace));
  }, [workspace.strategy.id]);

  useEffect(() => {
    if (selectedKey === "paper" && preferredKey !== "paper") setSelectedKey(preferredKey);
  }, [preferredKey, selectedKey]);

  const options = useMemo<SourceOption[]>(() => [
    {
      key: "paper",
      label: "PAPER TRADE ACCOUNT",
      mode: "PAPER",
      paper: workspace.paper,
      data: executionDeskData(paperData),
      freshness: workspace.paper ? workspace.paper.status : "UNAVAILABLE",
    },
    ...workspace.bindings.map((binding) => ({
      key: binding.id,
      label: `${String(binding.slotIndex).padStart(2, "0")} · ${binding.targetLabel || binding.targetProvider || binding.targetType.replaceAll("_", " ")}`,
      mode: "LIVE" as const,
      binding,
      snapshot: workspace.snapshots.find((snapshot) => snapshot.bindingId === binding.id),
      data: targetData[binding.id] || executionDeskData(null),
      freshness: workspace.snapshots.find((snapshot) => snapshot.bindingId === binding.id)?.freshness || "UNAVAILABLE",
    })),
  ], [paperData, targetData, workspace.bindings, workspace.paper, workspace.snapshots]);
  const selected = options.find((option) => option.key === selectedKey) || options[0]!;

  return <ExecutionDeskSurface
    strategy={workspace.strategy}
    options={options}
    selected={selected}
    onSelect={setSelectedKey}
    error={selectedKey === "paper" ? undefined : targetError}
    onRefresh={() => selected.binding ? void loadTarget(selected.binding) : undefined}
    busy={busy}
    onApplyConfiguration={onApplyConfiguration}
  />;
}

export function InvestmentGroupStrategyExecutionDesk({ groupId }: { groupId: string }) {
  const [desks, setDesks] = useState<StrategyGroupExecutionDesk[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await strategyAutomationApi.groupExecutionDesks(groupId, signal);
      if (signal?.aborted) return;
      setDesks(result.desks);
      setSelectedId((current) => result.desks.some((desk) => desk.strategy.id === current) ? current : result.desks[0]?.strategy.id);
      setError(undefined);
    } catch (nextError) {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : "Strategy Execution Desk is unavailable.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(controller.signal); }, 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh]);

  if (loading) return <div className="execution-desk-loading"><RefreshCw className="spin" size={18} /><strong>LOADING GROUP STRATEGY AUTHORITY</strong><span>Resolving the connected automated strategy and authoritative group execution state.</span></div>;
  if (!desks.length) return <div className="execution-desk-loading"><WifiOff size={18} /><strong>NO CONNECTED AUTOMATED STRATEGY</strong><span>This tab appears only while the Investment Group owns an active Strategy Lab target binding.</span>{error ? <em>{error}</em> : null}</div>;
  const desk = desks.find((item) => item.strategy.id === selectedId) || desks[0]!;
  const option: SourceOption = {
    key: desk.binding.id,
    label: desk.binding.targetLabel || "INVESTMENT GROUP",
    mode: "LIVE",
    binding: desk.binding,
    snapshot: desk.snapshot,
    data: executionDeskData(desk.data),
    freshness: desk.snapshot?.freshness || "UNAVAILABLE",
  };
  return <ExecutionDeskSurface
    strategy={desk.strategy}
    options={[option]}
    selected={option}
    error={error}
    onRefresh={() => void refresh()}
    strategyChoices={desks.map((item) => ({ id: item.strategy.id, label: `${item.strategy.name} · ${item.strategy.symbol} · ${item.strategy.timeframe.toUpperCase()}` }))}
    selectedStrategyId={desk.strategy.id}
    onStrategySelect={setSelectedId}
  />;
}

function ExecutionDeskSurface({
  strategy,
  options,
  selected,
  onSelect,
  error,
  onRefresh,
  strategyChoices,
  selectedStrategyId,
  onStrategySelect,
  busy = false,
  onApplyConfiguration,
}: {
  strategy: DeskStrategy;
  options: SourceOption[];
  selected: SourceOption;
  onSelect?: (key: string) => void;
  error?: string;
  onRefresh: () => void;
  strategyChoices?: Array<{ id: string; label: string }>;
  selectedStrategyId?: string;
  onStrategySelect?: (id: string) => void;
  busy?: boolean;
  onApplyConfiguration?: (definition: StrategyAutomationDefinition, policy: StrategyCapitalPolicy, sourceKey: string, panel: StrategyControlPanel) => Promise<void>;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { candles, calculationCandles, state: feedState, message: feedMessage } = useExecutionDeskCandles(strategy.definition);
  const actions = useMemo(() => buildExecutionDeskActions(selected.data, selected.mode), [selected.data, selected.mode]);
  const metrics = useMemo(() => buildExecutionDeskMetrics(selected.data, selected.paper, selected.snapshot), [selected.data, selected.paper, selected.snapshot]);
  const markers = useMemo(() => {
    const executed = executionMarkers(actions, candles.map((candle) => candle.time));
    const preview = historicalSignalMarkers(strategy.definition, calculationCandles, candles);
    const executedKeys = new Set(executed.map((marker) => `${marker.index}:${marker.direction}`));
    return [...preview.filter((marker) => !executedKeys.has(`${marker.index}:${marker.direction}`)), ...executed];
  }, [actions, calculationCandles, candles, strategy.definition]);
  const curve = useMemo(() => equityCurve(selected.data.trades), [selected.data.trades]);
  const latestAction = actions[0];
  const superAtrControlsAvailable = strategy.definition.runtimeKind === "builtin-superatr-seven-step" || /superatr/i.test(`${strategy.name} ${strategy.definition.indicator?.name || ""}`);
  const selectedPolicy = selected.binding?.capitalPolicy || selected.paper?.capitalPolicy;
  const controlPanel = useMemo(() => readStrategyControlPanel(strategy.definition, selectedPolicy, selected.paper?.demoEquity), [selected.paper?.demoEquity, selectedPolicy, strategy.definition]);
  return <section className="execution-desk">
    <header className="execution-desk-head">
      <div className="execution-desk-identity"><Crosshair size={16} /><span>STRATEGY EXECUTION DESK</span><strong>{strategy.name}</strong><em>V{strategy.runningVersion || "—"} · {strategy.exchange.toUpperCase()} {strategy.symbol} · {strategy.timeframe.toUpperCase()} · {strategy.marketType}</em></div>
      <div className="execution-desk-source-controls">
        {strategyChoices?.length ? <label><span>STRATEGY</span><select value={selectedStrategyId} onChange={(event) => onStrategySelect?.(event.target.value)}>{strategyChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label> : null}
        {options.length > 1 ? <label><span>EXECUTION ACCOUNT</span><select value={selected.key} onChange={(event) => onSelect?.(event.target.value)}>{options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label> : <div className="execution-desk-fixed-source"><span>EXECUTION ACCOUNT</span><strong>{selected.label}</strong></div>}
        <button type="button" aria-label="Refresh Execution Desk" onClick={onRefresh}><RefreshCw size={13} /></button>
        {onApplyConfiguration && superAtrControlsAvailable ? <button type="button" aria-label="Open strategy execution settings" onClick={() => setSettingsOpen(true)}><Settings2 size={13} /></button> : null}
      </div>
      <div className={`execution-desk-authority ${selected.freshness.toLowerCase()}`}><ShieldCheck size={13} /><span>{selected.mode === "PAPER" ? "ISOLATED PAPER" : "AUTHORITATIVE LIVE"}</span><strong>{selected.freshness}</strong></div>
    </header>

    {error ? <div className="execution-desk-warning"><WifiOff size={13} />{error} Last-known authoritative data remains visible.</div> : null}
    <div className="execution-desk-chart-shell">
      <div className="execution-desk-chart-toolbar"><div><span>DEDICATED ALGORITHMIC CHART</span><strong>{strategy.symbol} · {strategy.timeframe.toUpperCase()}</strong></div><div className={`execution-desk-feed ${feedState}`}><Wifi size={11} /><span>{feedMessage}</span></div><div><span>STRATEGY SOURCE</span><strong>{strategy.definition.indicator?.instanceName || strategy.definition.indicator?.name || strategy.definition.runtimeKind}</strong></div><div><span>LATEST ACTION</span><strong className={latestAction?.direction || "neutral"}>{latestAction?.action || "AWAITING SIGNAL"}</strong></div></div>
      <DedicatedStrategyChart definition={strategy.definition} candles={candles} markers={markers} />
      {!candles.length ? <div className="execution-desk-chart-empty"><Activity size={20} /><strong>LOADING {strategy.exchange.toUpperCase()} {strategy.symbol}</strong><span>The dedicated strategy feed is independent from the discretionary chart.</span></div> : null}
    </div>

    <ActionMatrix actions={actions} />
    <MetricDeck metrics={metrics} curve={curve} />
    <div className="execution-desk-separation"><Cloud size={13} /><span>This chart is owned by the strategy runtime. It never mounts the strategy onto the default discretionary chart.</span></div>
    {settingsOpen && selectedPolicy && onApplyConfiguration && superAtrControlsAvailable ? <StrategyControlPanelDialog name={strategy.name} accountLabel={selected.label} initial={controlPanel} busy={busy} onCancel={() => setSettingsOpen(false)} onApply={async (panel) => { await onApplyConfiguration(strategy.definition, selectedPolicy, selected.key, panel); setSettingsOpen(false); }} /> : null}
  </section>;
}

function DedicatedStrategyChart({ definition, candles, markers }: { definition: StrategyAutomationDefinition; candles: Candle[]; markers: ReturnType<typeof executionMarkers> }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<BlackChartEngine | null>(null);
  const engineReadyRef = useRef(false);
  const firstDataset = useRef(true);
  const candlesRef = useRef(candles);
  const markerRef = useRef(markers);
  const plotRef = useRef<CompiledPlot[]>([]);
  candlesRef.current = candles;
  const style = readStrategyControlPanel(definition).style;
  markerRef.current = style.tradesOnChart ? markers.map((marker) => style.signalLabels ? marker : { ...marker, label: "" }) : [];
  plotRef.current = strategyPlots(definition, candles);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let initialized = false;
    const engine = new BlackChartEngine({
      host,
      candles: [],
      chartType: "candlesticks",
      snapToLatest: true,
      visibleIndicators: executionDeskIndicators(definition),
      customPlots: plotRef.current,
      customMarkers: markerRef.current,
      priceLineColor: "#ff174a",
      priceLineIntensity: 92,
    });
    engineRef.current = engine;
    void engine.init().then(() => {
      initialized = true;
      if (disposed) { engine.destroy(); return; }
      engineReadyRef.current = true;
      if (candlesRef.current.length) {
        engine.setCandles(candlesRef.current);
        engine.setCustomScriptOutput(plotRef.current, markerRef.current);
        firstDataset.current = false;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      engineReadyRef.current = false;
      engineRef.current = null;
      if (initialized) engine.destroy();
      firstDataset.current = true;
    };
    // A new published strategy owns a new engine; candle updates are applied by
    // the effect below without resetting its independent viewport.
  }, [definition.indicator?.indicatorId, definition.runtimeKind]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !engineReadyRef.current || !candles.length) return;
    engine.setCandles(candles, { preserveView: !firstDataset.current });
    engine.setCustomScriptOutput(strategyPlots(definition, candles), markerRef.current);
    firstDataset.current = false;
  }, [candles, markers]);

  return <div ref={hostRef} className="execution-desk-chart" aria-label="Dedicated strategy execution chart" />;
}

function strategyPlots(definition: StrategyAutomationDefinition, candles: Candle[]): CompiledPlot[] {
  if (definition.runtimeKind !== "builtin-superatr-seven-step" || !candles.length || !strategyVisibleOnTimeframe(definition)) return [];
  const panel = readStrategyControlPanel(definition);
  const closes = candles.map((candle) => candle.close);
  return [
    { name: "Short MA", values: movingAverage(closes, panel.inputs.shortPeriod), color: panel.style.shortMaColor, width: panel.style.shortMaWidth, pane: "price", visible: panel.style.shortMaVisible },
    { name: "Long MA", values: movingAverage(closes, panel.inputs.longPeriod), color: panel.style.longMaColor, width: panel.style.longMaWidth, pane: "price", visible: panel.style.longMaVisible },
  ];
}

function historicalSignalMarkers(definition: StrategyAutomationDefinition, calculationCandles: Candle[], visibleCandles: Candle[]) {
  if (!calculationCandles.length || !visibleCandles.length || !["builtin-ema-cross", "builtin-adaptive-swing", "builtin-superatr-seven-step"].includes(definition.runtimeKind)) return [];
  const intervalSeconds = timeframeSeconds(definition.timeframe);
  const now = Date.now() / 1000;
  const confirmedCandles = calculationCandles.filter((candle) => candle.time + intervalSeconds <= now);
  try {
    const signals = createStrategySignals(definition.runtimeKind, confirmedCandles, definition.symbol, definition.settings);
    const panel = readStrategyControlPanel(definition);
    // TradingView's "One tick" order delay fills a market order at the next
    // available tick (the following bar's open in a historical OHLC backtest).
    const processOrdersOnClose = definition.execution?.executionDelay === "NONE"
      && definition.execution?.processOrdersOnClose === true;
    return strategySignalMarkers(signals, visibleCandles, intervalSeconds, {
      pyramiding: panel.properties.pyramiding,
      processOrdersOnClose,
    });
  } catch {
    return [];
  }
}

function movingAverage(values: number[], period: number) {
  const length = Math.max(1, Math.round(period));
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= length) sum -= values[index - length]!;
    return sum / Math.min(index + 1, length);
  });
}

function strategyVisibleOnTimeframe(definition: StrategyAutomationDefinition) {
  const visibility = readStrategyControlPanel(definition).visibility;
  if (visibility.allTimeframes) return true;
  const timeframe = definition.timeframe;
  if (timeframe.endsWith("s") || timeframe.endsWith("t")) return visibility.seconds;
  if (timeframe.endsWith("m")) return visibility.minutes;
  if (timeframe.endsWith("h")) return visibility.hours;
  if (timeframe.endsWith("d")) return visibility.days;
  if (timeframe.endsWith("w")) return visibility.weeks;
  return visibility.months;
}

function ActionMatrix({ actions }: { actions: ExecutionDeskAction[] }) {
  const recent = actions.slice(0, 80);
  return <section className="execution-action-matrix">
    <header><div><Activity size={13} /><span>STRATEGY ACTION TAPE</span></div><strong>{recent.length ? `${recent.length} LATEST AUTHORITATIVE ACTIONS` : "AWAITING FIRST FILL"}</strong></header>
    <div className="execution-action-legend">{["LONG", "SHORT", "TP1", "TP2", "TP3", "TP4", "TP5", "TP6", "TP7", "CLOSE POSITION LONG", "CLOSE POSITION SHORT"].map((label) => <span key={label} data-active={actions.some((action) => action.action === label) || undefined}>{label}</span>)}</div>
    {recent.length ? <div className="execution-action-table-wrap"><table><thead><tr><th>TIME</th><th>ACTION</th><th>PRICE</th><th>SIZE</th><th>REALIZED</th><th>MODE</th><th>DETAIL</th></tr></thead><tbody>{recent.map((action) => <tr key={action.id}><td>{dateTime(action.time)}</td><td><b className={`action-chip ${action.role} ${action.direction}`}>{action.action}</b></td><td>{price(action.price)}</td><td>{quantity(action.quantity)}</td><td className={Number(action.pnl || 0) >= 0 ? "positive" : "negative"}>{action.pnl === undefined ? "—" : signedMoney(action.pnl)}</td><td>{action.source}</td><td title={action.detail}>{action.detail}</td></tr>)}</tbody></table></div> : <div className="execution-desk-no-actions"><Crosshair size={17} /><strong>NO EXECUTED ACTIONS YET</strong><span>Confirmed LONG, SHORT, TP1–TP7 and position-close fills will be written here and pinned to their exact chart price.</span></div>}
  </section>;
}

function MetricDeck({ metrics, curve }: { metrics: ExecutionDeskMetrics; curve: Array<{ time: number; value: number }> }) {
  const cards: Array<[string, string, string]> = [
    ["ONGOING PNL", signedMoney(metrics.ongoingPnl), metrics.ongoingPnl >= 0 ? "positive" : "negative"],
    ["WIN RATE", `${metrics.winRate.toFixed(2)}%`, metrics.winRate >= 50 ? "positive" : "negative"],
    ["MAX DRAWDOWN", `${metrics.maximumDrawdown.toFixed(2)}%`, metrics.maximumDrawdown > 10 ? "negative" : "neutral"],
    ["PROFIT FACTOR", metrics.profitFactor === null ? "∞" : metrics.profitFactor.toFixed(2), (metrics.profitFactor || 0) >= 1 ? "positive" : "negative"],
    ["EQUITY", money(metrics.equity), "neutral"],
    ["UNREALIZED", signedMoney(metrics.unrealizedPnl), metrics.unrealizedPnl >= 0 ? "positive" : "negative"],
    ["TRADES", String(metrics.tradeCount), "neutral"],
    ["OPEN POSITIONS", String(metrics.openPositions), "neutral"],
  ];
  return <section className="execution-statistics">
    <div className="execution-stat-grid">{cards.map(([label, value, tone]) => <article key={label}><span>{label}</span><strong className={tone}>{value}</strong></article>)}</div>
    <div className="execution-stat-detail"><EquitySparkline points={curve} /><div className="execution-detail-grid"><SmallMetric label="REALIZED PNL" value={signedMoney(metrics.realizedPnl)} /><SmallMetric label="CURRENT DD" value={`${metrics.currentDrawdown.toFixed(2)}%`} /><SmallMetric label="GROSS PNL" value={signedMoney(metrics.grossPnl)} /><SmallMetric label="FEES" value={money(metrics.fees)} /><SmallMetric label="FUNDING" value={signedMoney(metrics.funding)} /><SmallMetric label="SHARPE" value={metrics.sharpe.toFixed(2)} /><SmallMetric label="SORTINO" value={metrics.sortino.toFixed(2)} /><SmallMetric label="OPEN ORDERS" value={String(metrics.openOrders)} /></div></div>
  </section>;
}

function EquitySparkline({ points }: { points: Array<{ time: number; value: number }> }) {
  const values = points.map((point) => point.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(1, max - min);
  const coords = points.map((point, index) => `${points.length <= 1 ? 0 : index / (points.length - 1) * 100},${36 - (point.value - min) / span * 32}`).join(" ");
  const positive = (values.at(-1) || 0) >= 0;
  return <div className="execution-equity-curve"><header><div><BarChart3 size={12} /><span>REALIZED EQUITY CURVE</span></div><strong className={positive ? "positive" : "negative"}>{values.length ? signedMoney(values.at(-1) || 0) : "NO CLOSED TRADES"}</strong></header><svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="Realized equity curve"><line x1="0" y1={36 - (0 - min) / span * 32} x2="100" y2={36 - (0 - min) / span * 32} />{coords ? <><polyline className={positive ? "positive" : "negative"} points={coords} /><polygon className={positive ? "positive" : "negative"} points={`0,40 ${coords} 100,40`} /></> : null}</svg></div>;
}

function SmallMetric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

function useExecutionDeskCandles(definition: StrategyAutomationDefinition) {
  const [calculationCandles, setCalculationCandles] = useState<Candle[]>([]);
  const [state, setState] = useState<"loading" | "live" | "degraded">("loading");
  const [message, setMessage] = useState("DEDICATED FEED CONNECTING");
  // Keep the full paginated research window on the dedicated strategy chart.
  // The first 1,000+ bars remain calculation seed, so the user can inspect up
  // to 9,000 authoritative fills without flattening indicator state at the
  // left edge of the visible chart.
  const visibleBarCount = 9_000;
  const calculationBarCount = executionDeskCalculationBarCount(definition, visibleBarCount);
  const candles = useMemo(() => calculationCandles.slice(-visibleBarCount), [calculationCandles]);

  useEffect(() => {
    const exchange = normalizeExchange(definition.exchange);
    const timeframe = normalizeTimeframe(definition.timeframe);
    const marketKind = definition.marketType === "SPOT" ? "spot" as const : "perpetual" as const;
    const controller = new AbortController();
    let disposed = false;
    let subscription: MarketDataSubscription<Candle> | undefined;
    let refreshTimer: number | undefined;
    let adapter: ReturnType<typeof getMarketDataEngineAdapter>;
    setCalculationCandles([]);
    setState("loading");
    try { adapter = getMarketDataEngineAdapter(exchange); }
    catch (error) {
      setState("degraded");
      setMessage(error instanceof Error ? error.message.toUpperCase() : "VENUE ADAPTER UNAVAILABLE");
      return () => controller.abort();
    }
    const symbol = adapter.normalizeSymbol(definition.symbol.replace(/[^A-Za-z0-9]/g, ""), marketKind);
    const merge = (incoming: Candle[]) => setCalculationCandles((current) => uniqueCandles([...current, ...incoming]).slice(-calculationBarCount));
    const fetchHistory = async (initial = false) => {
      try {
        let rows = await adapter.getHistoricalCandles({ exchange, symbol, timeframe, marketKind, limit: initial ? visibleBarCount : 8, signal: controller.signal });
        if (initial && rows.length) {
          let oldest = rows[0]!.time;
          while (rows.length < calculationBarCount) {
            const requested = Math.min(1_000, calculationBarCount - rows.length);
            const older = await adapter.getHistoricalCandles({
              exchange,
              symbol,
              timeframe,
              marketKind,
              limit: requested,
              to: oldest - 1,
              signal: controller.signal,
            });
            if (!older.length) break;
            const merged = uniqueCandles([...older, ...rows]);
            if (merged.length === rows.length) break;
            rows = merged;
            oldest = rows[0]!.time;
          }
        }
        if (disposed) return;
        merge(rows);
        setState("live");
        setMessage(`${adapter.label.toUpperCase()} LIVE · ${rows.length ? `${Math.min(rows.length, calculationBarCount)}-BAR SEEDED OHLCV` : "WAITING FOR BAR"}`);
      } catch (error) {
        if (!disposed && !controller.signal.aborted) {
          setState((current) => current === "live" ? "live" : "degraded");
          setMessage(`${adapter.label.toUpperCase()} HISTORY RETRY · ${error instanceof Error ? error.message.toUpperCase() : "UNAVAILABLE"}`);
        }
      }
    };
    void fetchHistory(true).then(() => {
      if (disposed) return;
      subscription = adapter.subscribeCandles?.({ exchange, symbol, timeframe, marketKind, limit: 1 }, (candle) => {
        if (disposed) return;
        merge([candle]);
        setState("live");
        setMessage(`${adapter.label.toUpperCase()} LIVE · DEDICATED ${timeframe.toUpperCase()} STREAM`);
      });
      subscription?.onError(() => { if (!disposed) setMessage(`${adapter.label.toUpperCase()} REST HEARTBEAT · STREAM RECOVERING`); });
    });
    refreshTimer = window.setInterval(() => { if (document.visibilityState === "visible") void fetchHistory(false); }, 12_000);
    const restore = () => { if (document.visibilityState === "visible") void fetchHistory(false); };
    document.addEventListener("visibilitychange", restore);
    return () => {
      disposed = true;
      controller.abort();
      subscription?.unsubscribe();
      if (refreshTimer) window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", restore);
    };
  }, [calculationBarCount, definition.exchange, definition.marketType, definition.symbol, definition.timeframe, visibleBarCount]);
  return { candles, calculationCandles, state, message };
}

function executionDeskCalculationBarCount(definition: StrategyAutomationDefinition, visibleBarCount: number) {
  const required = definition.runtimeKind === "builtin-superatr-seven-step"
    ? superAtrRequiredSeedBars(definition.settings)
    : Math.max(1, Number(definition.indicator?.warmupBars || 0));
  // Keep at least one complete hidden page so the position at the visible
  // boundary comes from prior strategy history rather than an artificial flat.
  const hidden = Math.max(1_000, required * 2);
  return Math.min(10_000, visibleBarCount + hidden);
}

function executionDeskIndicators(definition: StrategyAutomationDefinition): VisibleIndicators {
  const key = String(definition.indicator?.indicatorId || "").replace(/^library:/, "").replace(/^chart:/, "");
  return {
    qalc: false, liquidationHeatmap: false, auctionProfile: false, volatilityHeatmap: false, volumeProfile: false, aif: false,
    adaptiveSwingStrategy: key === "adaptiveSwingStrategy" || definition.runtimeKind === "builtin-adaptive-swing",
    vwap: key === "vwap",
    ema20: key === "ema20" || definition.runtimeKind === "builtin-ema-cross",
    ema50: key === "ema50" || definition.runtimeKind === "builtin-ema-cross",
    ema200: key === "ema200",
    sma20: key === "sma20", sma50: key === "sma50", bollinger: key === "bollinger",
    openInterestOscillator: false, zScoreOscillator: false, waveTrendOscillator: false, ddaProOscillator: false, acvdOscillator: false, cvdOscillator: false, marketSentimentOscillator: false,
    volume: true,
  };
}

function normalizeExchange(value: string): ExchangeId {
  const normalized = String(value || "").toLowerCase().replaceAll(" ", "-");
  return exchangeRegistry.some((item) => item.id === normalized) ? normalized as ExchangeId : "bybit";
}
function normalizeTimeframe(value: string): Timeframe { const normalized = String(value || "").trim() as Timeframe; return timeframeSet.has(normalized) ? normalized : "1h"; }
function timeframeSeconds(value: string) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/^(\d+)([smhdwM])$/);
  if (!match) return 3600;
  const amount = Math.max(1, Number(match[1]));
  const unit = match[2];
  return amount * (unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : unit === "w" ? 604800 : 2592000);
}
function preferredExecutionSource(workspace: StrategyWorkspace) {
  const plan = workspace.strategy.definition.deployment;
  if (plan && plan.targetType !== "PAPER") {
    const planned = workspace.bindings.find((binding) => binding.targetId === plan.targetId && binding.status !== "DISCONNECTED");
    if (planned) return planned.id;
    const live = workspace.bindings.find((binding) => binding.status === "LIVE");
    if (live) return live.id;
  }
  return "paper";
}
function uniqueCandles(rows: Candle[]) { return [...new Map(rows.filter((row) => Number.isFinite(row.time) && row.close > 0).map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time); }
function money(value: number) { return `$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function signedMoney(value: number) { return `${value >= 0 ? "+" : "-"}${money(value)}`; }
function price(value: number) { return value.toLocaleString(undefined, { minimumFractionDigits: value >= 100 ? 2 : 4, maximumFractionDigits: value >= 100 ? 2 : 8 }); }
function quantity(value: number) { return value ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : "—"; }
function dateTime(value: number) { return new Date(value * 1000).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
