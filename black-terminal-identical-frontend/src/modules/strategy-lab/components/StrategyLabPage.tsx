import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Database, FlaskConical, LockKeyhole, X } from "lucide-react";
import type { IndicatorAlertDefinition } from "../../../automation/alerts";
import type { AdaptiveSwingStrategySettings, Candle, IndicatorAdvancedSettings, IndicatorPeriods, VisibleIndicators } from "../../../chart-engine/types";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import { dbGetCurrentUserScripts, isSupabaseConfigured } from "../../../lib/supabase";
import { normalizeUserScripts, type UserScript } from "../../../scripts/userScriptLibrary";
import { isLocalOnlyRuntime } from "../../../core/local-runtime/localRuntimeClient";
import { loadLocalUserScripts } from "../../../core/local-runtime/localUserScriptStore";
import { createAIStrategyReview } from "../ai/aiStrategyReview";
import { fetchStrategyLabCandles, fetchStrategyLabIntrabars } from "../adapters/marketDataAdapter";
import { runBlackScriptBacktest } from "../adapters/pythonStrategyAdapter";
import { createStrategySignals } from "../adapters/signalAdapter";
import { runBacktest } from "../engine/backtestEngine";
import { runOptimization } from "../engine/optimizer";
import { buildStrategyReviewInput } from "../engine/tradeAnalyzer";
import { runWalkForward } from "../engine/walkForward";
import { createDefaultBacktestConfig } from "../state/strategyLabStore";
import { StrategyAutomationExperience } from "../my-strategy/StrategyAutomationExperience";
import { buildSelectableIndicatorInstances, ownedCustomIndicatorInstances, stableHash } from "../my-strategy/state/indicatorManifest";
import {
  applyAutomationDefinitionToConfig,
  marketSymbolFromBacktestConfig,
} from "../automation/strategyDefinitionModel";
import type { StrategyAutomationDefinition } from "../automation/strategyAutomation.types";
import type { StrategyWorkspace } from "../automation/strategyAutomation.types";
import { readStrategyControlPanel } from "../execution-desk/strategyControlPanelModel";
import type { AIStrategyReview, CodeSuggestion } from "../types/ai.types";
import type { BacktestConfig, BacktestResult, BacktestRunState, TradeResult } from "../types/backtest.types";
import type { OptimizationResult, OptimizationSpace, WalkForwardWindow } from "../types/optimization.types";
import type { StrategyRuntimeKind } from "../types/strategy.types";
import { AIReviewPanel } from "./AIReviewPanel";
import { BacktestPanel } from "./BacktestPanel";
import { CodeSuggestionsPanel } from "./CodeSuggestionsPanel";
import { DrawdownCurvePanel, EquityCurvePanel, PeriodPerformancePanel } from "./CurvePanels";
import { formatCurrency, formatNumber, formatPercent } from "./format";
import { ForwardTestPanel } from "./ForwardTestPanel";
import { HeatmapPanel } from "./HeatmapPanel";
import { OptimizationPanel } from "./OptimizationPanel";
import { OverviewPanel } from "./OverviewPanel";
import { StrategyLabTab, StrategyTabs } from "./StrategyTabs";
import { TradesTable } from "./TradesTable";

type StrategyLabPageProps = {
  currentUser: { username: string; role: "admin" | "user" } | null;
  marketSymbol: MarketSymbol;
  displaySymbol: string;
  exchangeLabel: string;
  timeframe: Timeframe;
  selectedStrategyKind: StrategyRuntimeKind;
  strategySelectionRevision: number;
  adaptiveSwingSettings?: AdaptiveSwingStrategySettings;
  visibleIndicators: VisibleIndicators;
  indicatorPeriods: IndicatorPeriods;
  indicatorAdvancedSettings: IndicatorAdvancedSettings;
  indicatorAlerts: IndicatorAlertDefinition[];
  onClose: () => void;
  onTradeSelect?: (trade: TradeResult) => void;
};

const defaultOptimizationSpace: OptimizationSpace = {
  swingLookback: { min: 16, max: 40, step: 4 },
  atrStopMultiplier: { min: 1, max: 2.2, step: 0.2 },
  takeProfitRatio: { min: 1.2, max: 3.5, step: 0.4 },
  minTrendQuality: { min: 0.18, max: 0.46, step: 0.04 }
};

const researchTabs = [
  ["overview", "Overview"], ["trades", "Trades"], ["equity", "Equity Curve"], ["drawdown", "Drawdown"],
  ["optimization", "Optimization"], ["heatmap", "Heatmap"], ["aiReview", "AI Review"], ["codeSuggestions", "Code Suggestions"], ["forwardTest", "Forward Test"],
] as const;

function createOptimizationSpace(adaptiveSwingSettings?: AdaptiveSwingStrategySettings): OptimizationSpace {
  if (!adaptiveSwingSettings?.optimizationEnabled) return defaultOptimizationSpace;
  return {
    swingLookback: {
      min: adaptiveSwingSettings.optimizeSwingLookbackMin,
      max: adaptiveSwingSettings.optimizeSwingLookbackMax,
      step: adaptiveSwingSettings.optimizeSwingLookbackStep
    },
    atrStopMultiplier: {
      min: adaptiveSwingSettings.optimizeAtrStopMin,
      max: adaptiveSwingSettings.optimizeAtrStopMax,
      step: adaptiveSwingSettings.optimizeAtrStopStep
    },
    takeProfitRatio: {
      min: adaptiveSwingSettings.optimizeTakeProfitMin,
      max: adaptiveSwingSettings.optimizeTakeProfitMax,
      step: adaptiveSwingSettings.optimizeTakeProfitStep
    },
    minTrendQuality: {
      min: adaptiveSwingSettings.optimizeTrendQualityMin,
      max: adaptiveSwingSettings.optimizeTrendQualityMax,
      step: adaptiveSwingSettings.optimizeTrendQualityStep
    }
  };
}

function summarizeWalkForward(windows: WalkForwardWindow[]) {
  if (windows.length === 0) return { stability: 0, highRisk: 0 };
  return {
    stability: windows.reduce((sum, item) => sum + item.stability, 0) / windows.length,
    highRisk: windows.filter((item) => item.overfittingRisk === "High").length
  };
}

function createConfig(
  marketSymbol: MarketSymbol,
  displaySymbol: string,
  exchangeLabel: string,
  timeframe: Timeframe,
  selectedStrategyKind: StrategyRuntimeKind,
  adaptiveSwingSettings?: AdaptiveSwingStrategySettings
): BacktestConfig {
  const config = {
    ...createDefaultBacktestConfig(marketSymbol, displaySymbol, exchangeLabel, timeframe),
    strategyKind: selectedStrategyKind
  };

  if (selectedStrategyKind === "builtin-adaptive-swing" && adaptiveSwingSettings) {
    config.strategySettings = {
      ...config.strategySettings,
      stopLossPercent: adaptiveSwingSettings.stopLossPercent,
      takeProfitRatio: adaptiveSwingSettings.takeProfitRatio,
      atrLength: adaptiveSwingSettings.atrLength,
      regimeEmaLength: adaptiveSwingSettings.regimeEmaLength,
      swingLookback: adaptiveSwingSettings.swingLookback,
      rsiLength: adaptiveSwingSettings.rsiLength,
      rsiOversold: adaptiveSwingSettings.rsiOversold,
      rsiOverbought: adaptiveSwingSettings.rsiOverbought,
      atrStopMultiplier: adaptiveSwingSettings.atrStopMultiplier,
      swingRetestAtr: adaptiveSwingSettings.swingRetestAtr,
      minTrendQuality: adaptiveSwingSettings.minTrendQuality,
      maxChopRatio: adaptiveSwingSettings.maxChopRatio,
      volumeLookback: adaptiveSwingSettings.volumeLookback,
      minVolumeMultiplier: adaptiveSwingSettings.minVolumeMultiplier,
      sessionStartHour: adaptiveSwingSettings.sessionStartHour,
      sessionEndHour: adaptiveSwingSettings.sessionEndHour
    };
  }

  return config;
}

export function StrategyLabPage({
  currentUser,
  marketSymbol,
  displaySymbol,
  exchangeLabel,
  timeframe,
  selectedStrategyKind,
  strategySelectionRevision,
  adaptiveSwingSettings,
  visibleIndicators,
  indicatorPeriods,
  indicatorAdvancedSettings,
  indicatorAlerts,
  onClose,
  onTradeSelect
}: StrategyLabPageProps) {
  const [activeTab, setActiveTab] = useState<StrategyLabTab>("myStrategy");
  const [researchView, setResearchView] = useState<"overview" | "trades" | "equity" | "drawdown" | "optimization" | "heatmap" | "aiReview" | "codeSuggestions" | "forwardTest">("overview");
  const [config, setConfig] = useState<BacktestConfig>(() => createConfig(marketSymbol, displaySymbol, exchangeLabel, timeframe, selectedStrategyKind, adaptiveSwingSettings));
  const [candles, setCandles] = useState<Candle[]>([]);
  const [result, setResult] = useState<BacktestResult | undefined>();
  const [runState, setRunState] = useState<BacktestRunState>("idle");
  const [error, setError] = useState<string | undefined>();
  const [optimizationSpace, setOptimizationSpace] = useState<OptimizationSpace>(() => createOptimizationSpace(adaptiveSwingSettings));
  const [optimizationResults, setOptimizationResults] = useState<OptimizationResult[]>([]);
  const [optimizationBusy, setOptimizationBusy] = useState(false);
  const [walkForward, setWalkForward] = useState<WalkForwardWindow[]>([]);
  const [review, setReview] = useState<AIStrategyReview | undefined>();
  const [codeSuggestions, setCodeSuggestions] = useState<CodeSuggestion[]>([]);
  const [ownedScripts, setOwnedScripts] = useState<UserScript[]>([]);
  const [backtestDefinition, setBacktestDefinition] = useState<StrategyAutomationDefinition>();

  useEffect(() => {
    let cancelled = false;
    const loadOwnedScripts = async () => {
      try {
        const rows = currentUser && isSupabaseConfigured && !isLocalOnlyRuntime()
          ? await dbGetCurrentUserScripts()
          : isLocalOnlyRuntime()
            ? await loadLocalUserScripts(currentUser?.username)
            : JSON.parse(window.localStorage.getItem(currentUser ? `bt_user_scripts:${currentUser.username}` : "bt_user_scripts:anonymous") || "[]");
        if (!cancelled) setOwnedScripts(normalizeUserScripts(rows));
      } catch (catalogError) {
        if (!cancelled) {
          setOwnedScripts([]);
          setError(`Private script catalog could not be loaded: ${catalogError instanceof Error ? catalogError.message : "Unknown storage error"}`);
        }
      }
    };
    void loadOwnedScripts();
    return () => { cancelled = true; };
  }, [currentUser?.username]);

  useEffect(() => {
    setConfig(createConfig(marketSymbol, displaySymbol, exchangeLabel, timeframe, selectedStrategyKind, adaptiveSwingSettings));
    setCandles([]);
    setResult(undefined);
    setOptimizationSpace(createOptimizationSpace(adaptiveSwingSettings));
    setOptimizationResults([]);
    setWalkForward([]);
    setReview(undefined);
    setCodeSuggestions([]);
    setError(undefined);
    setRunState("idle");
    setBacktestDefinition(undefined);
  }, [adaptiveSwingSettings, displaySymbol, exchangeLabel, marketSymbol, selectedStrategyKind, timeframe]);

  useEffect(() => {
    if (strategySelectionRevision === 0) return;
    setActiveTab("backtest");
  }, [strategySelectionRevision]);

  const status = runState === "completed"
    ? `${result?.candlesTested.toLocaleString() ?? 0} BARS`
    : runState.toUpperCase().replace("-", " ");

  const run = async (nextTab: StrategyLabTab = "analytics") => {
    setError(undefined);
    setRunState("loading-data");
    try {
      const configuredMarket = marketSymbolFromBacktestConfig(config);
      const history = await fetchStrategyLabCandles(configuredMarket, config.timeframe, config.startDate, config.endDate, 1800);
      setCandles(history);
      setRunState("running");
      let nextResult: BacktestResult;
      if (config.strategyKind === "python-script") {
        const definition = backtestDefinition;
        if (!definition?.indicator?.indicatorId.startsWith("custom:")) {
          throw new Error("Select a saved owned Black Script strategy before running this backtest.");
        }
        const scriptId = definition.indicator.indicatorId.slice("custom:".length);
        const script = ownedScripts.find((item) => item.id === scriptId && item.kind === "strategy");
        if (!script) throw new Error("The exact saved strategy source is unavailable in your authenticated script library.");
        if (definition.indicator.version && definition.indicator.version !== stableHash(script.source)) {
          throw new Error("The saved strategy version does not match the current script source. Publish or select the matching version before backtesting.");
        }
        const panel = readStrategyControlPanel(definition);
        const highDetail = panel.properties.barDetailization === "HIGH_LOWER_TIMEFRAME" || /use_bar_magnifier\s*=\s*True/i.test(script.source);
        const magnifier = highDetail
          ? await fetchStrategyLabIntrabars(configuredMarket, config.timeframe, history)
          : null;
        const inputValues = Object.fromEntries(Object.entries(definition.settings).filter(([, value]) => ["number", "boolean", "string"].includes(typeof value))) as Record<string, number | boolean | string>;
        nextResult = runBlackScriptBacktest({
          source: script.source,
          candles: history,
          config,
          inputValues,
          intrabars: magnifier?.intrabars,
          runtimeConfig: {
            initialCapital: config.initialCapital,
            defaultQuantityMode: panel.properties.orderSizeMode === "FIXED_QUANTITY" ? "fixed" : panel.properties.orderSizeMode === "FIXED_USDT" ? "cash" : "percent_of_equity",
            defaultQuantityValue: panel.properties.orderSizeValue,
            commissionMode: panel.properties.commissionMode === "USDT_PER_ORDER" ? "cash_per_order" : "percent",
            commissionValue: panel.properties.commissionValue,
            slippageTicks: panel.properties.slippageTicks,
            tickSize: config.tickSize,
            pyramiding: panel.properties.pyramiding,
            processOrdersOnClose: panel.properties.executionDelay === "NONE",
            historicalFillMode: panel.properties.barDetailization === "CLOSED_BAR" ? "conservative" : "tradingview",
            useBarMagnifier: highDetail,
          },
        });
        if (highDetail && magnifier && magnifier.coveredBars < magnifier.requestedBars) {
          nextResult.warnings.push(`Lower-timeframe coverage was available for ${magnifier.coveredBars.toLocaleString()} of ${magnifier.requestedBars.toLocaleString()} bars; uncovered history used deterministic four-tick fills.`);
        }
      } else {
        const signals = createStrategySignals(config.strategyKind, history, config.symbol, config.strategySettings);
        nextResult = runBacktest(history, signals, config);
      }
      setResult(nextResult);
      const reviewInput = buildStrategyReviewInput(nextResult, optimizationResults);
      const nextReview = createAIStrategyReview(reviewInput);
      setReview(nextReview);
      setCodeSuggestions(nextReview.codeSuggestions);
      setRunState("completed");
      setActiveTab(nextTab);
    } catch (err) {
      setRunState("failed");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runOptimizer = () => {
    if (candles.length === 0 || !result) {
      setError("Run a backtest before optimization so Strategy Lab has a historical candle set.");
      return;
    }

    setOptimizationBusy(true);
    window.setTimeout(() => {
      try {
        const next = runOptimization(candles, config, optimizationSpace, 64);
        const wf = runWalkForward(candles, config, optimizationSpace, 360, 120, 24);
        setOptimizationResults(next);
        setWalkForward(wf);
        const nextReview = createAIStrategyReview(buildStrategyReviewInput(result, next));
        setReview(nextReview);
        setCodeSuggestions(nextReview.codeSuggestions);
        setResearchView("optimization");
        setActiveTab("research");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setOptimizationBusy(false);
      }
    }, 20);
  };

  const wfSummary = useMemo(() => summarizeWalkForward(walkForward), [walkForward]);
  const automationDefinition = useMemo<StrategyAutomationDefinition>(
    () => ({
      runtimeKind: config.strategyKind,
      symbol: config.symbol,
      timeframe: config.timeframe,
      marketType: config.marketKind === "spot" ? "SPOT" : "FUTURES",
      exchange: "bybit",
      settings: config.strategySettings,
      execution: {
        feeRate: config.feeRate,
        slippageTicks: config.slippageTicks,
        tickSize: config.tickSize,
        spreadBps: config.spreadBps,
        useBidAskExecution: config.useBidAskExecution,
        maxTradesPerDay: config.maxTradesPerDay,
        maxDailyLoss: config.maxDailyLoss,
        maxDrawdown: config.maxDrawdown,
        maxOpenPositions: config.maxOpenPositions,
        maxLeverage: config.maxLeverage,
        cooldownAfterLosses: config.cooldownAfterLosses,
        disableOnHighSpreadBps: config.disableOnHighSpreadBps,
        disableOnLowLiquidity: config.disableOnLowLiquidity,
        disableOnAbnormalVolatility: config.disableOnAbnormalVolatility,
        fundingRatePerDay: config.fundingRatePerDay
      }
    }),
    [config]
  );
  const updateAutomationDefinition = useCallback(
    (definition: StrategyAutomationDefinition) => {
      setBacktestDefinition(definition);
      setConfig((current) =>
        applyAutomationDefinitionToConfig(current, definition),
      );
      setCandles([]);
      setResult(undefined);
      setOptimizationResults([]);
      setWalkForward([]);
      setReview(undefined);
      setCodeSuggestions([]);
      setError(undefined);
      setRunState("idle");
    },
    [],
  );
  const selectableIndicatorInstances = useMemo(() => [...buildSelectableIndicatorInstances({
    visible: visibleIndicators,
    periods: indicatorPeriods,
    advanced: indicatorAdvancedSettings,
    configuredAlerts: indicatorAlerts,
  }), ...ownedCustomIndicatorInstances(ownedScripts)], [visibleIndicators, indicatorPeriods, indicatorAdvancedSettings, indicatorAlerts, ownedScripts]);

  const openStrategyBacktest = useCallback((workspace: StrategyWorkspace) => {
    setBacktestDefinition(workspace.strategy.definition);
    setConfig((current) => applyAutomationDefinitionToConfig(current, workspace.strategy.definition));
    setActiveTab("backtest");
  }, []);

  const renderAnalyticsDashboard = () => <div className="strategy-dashboard-grid">
    <OverviewPanel result={result} status={status} />
    <div className="strategy-panel strategy-side-summary">
      <div className="strategy-panel-head"><span>ANALYTICS STATE</span><b>{config.exchangeLabel.toUpperCase()}</b></div>
      <div className="strategy-kv-grid"><div><span>Symbol</span><strong>{config.symbol}</strong></div><div><span>Timeframe</span><strong>{config.timeframe}</strong></div><div><span>Candles</span><strong>{candles.length.toLocaleString()}</strong></div><div><span>Trades</span><strong>{result?.metrics.totalTrades ?? 0}</strong></div><div><span>Net</span><strong>{result ? formatCurrency(result.metrics.netProfit) : "-"}</strong></div><div><span>Return</span><strong>{result ? formatPercent(result.metrics.returnOnCapital) : "-"}</strong></div><div><span>Robust Avg</span><strong>{formatNumber(optimizationResults.reduce((sum, item) => sum + item.robustnessScore, 0) / Math.max(1, optimizationResults.length), 1)}</strong></div><div><span>WF Stability</span><strong>{formatPercent(wfSummary.stability)}</strong></div></div>
      <button type="button" className="strategy-primary-button wide" onClick={() => run()}><FlaskConical size={14} /> RUN CURRENT MODEL</button>
      <button type="button" className="strategy-secondary-button wide" disabled={!result || optimizationBusy} onClick={runOptimizer}><Database size={14} /> RUN OPTIMIZATION</button>
      <button type="button" className="strategy-secondary-button wide" disabled={!result} onClick={() => { setResearchView("aiReview"); setActiveTab("research"); }}><Bot size={14} /> OPEN AI REVIEW</button>
      {error ? <div className="strategy-error">{error}</div> : null}
    </div>
    <EquityCurvePanel points={result?.equityCurve ?? []} /><DrawdownCurvePanel points={result?.drawdownCurve ?? []} />
  </div>;

  const renderResearch = () => <div className="strategy-research"><nav>{researchTabs.map(([id, label]) => <button type="button" key={id} className={researchView === id ? "active" : ""} onClick={() => setResearchView(id)}>{label}</button>)}</nav><div>
    {researchView === "overview" ? renderAnalyticsDashboard() : null}
    {researchView === "trades" ? <TradesTable trades={result?.trades ?? []} onTradeSelect={onTradeSelect} /> : null}
    {researchView === "equity" ? <div className="strategy-split-grid"><EquityCurvePanel points={result?.equityCurve ?? []} /><PeriodPerformancePanel title="DAILY PNL" rows={result?.metrics.dailyBreakdown ?? []} /><PeriodPerformancePanel title="MONTHLY PERFORMANCE" rows={result?.metrics.monthlyBreakdown ?? []} /></div> : null}
    {researchView === "drawdown" ? <DrawdownCurvePanel points={result?.drawdownCurve ?? []} /> : null}
    {researchView === "optimization" ? <OptimizationPanel space={optimizationSpace} results={optimizationResults} busy={optimizationBusy} onSpaceChange={setOptimizationSpace} onRun={runOptimizer} /> : null}
    {researchView === "heatmap" ? <HeatmapPanel results={optimizationResults} /> : null}
    {researchView === "aiReview" ? <AIReviewPanel review={review} /> : null}
    {researchView === "codeSuggestions" ? <CodeSuggestionsPanel suggestions={codeSuggestions} onChange={setCodeSuggestions} /> : null}
    {researchView === "forwardTest" ? <ForwardTestPanel result={result} symbol={config.symbol} /> : null}
  </div></div>;

  const renderActiveTab = () => {
    if (activeTab === "myStrategy") {
      return <StrategyAutomationExperience definition={automationDefinition} chartTimeframe={timeframe} indicators={selectableIndicatorInstances} onDefinitionChange={updateAutomationDefinition} onOpenBacktest={openStrategyBacktest} />;
    }
    if (activeTab === "backtest") {
      return <BacktestPanel config={config} runState={runState} error={error} onConfigChange={setConfig} onRun={() => run()} />;
    }
    if (activeTab === "analytics") return renderAnalyticsDashboard();
    if (activeTab === "research") return renderResearch();
    if (activeTab === "paperTrading") return <div className="strategy-primary-empty"><FlaskConical size={25} /><strong>Paper Trading lives inside each strategy cockpit</strong><span>Open a saved strategy to view its Paper equity, positions, trades, controls and runtime health.</span><button type="button" onClick={() => setActiveTab("myStrategy")}>OPEN MY STRATEGY</button></div>;
    if (activeTab === "liveAutomation") return <div className="strategy-primary-empty locked"><LockKeyhole size={25} /><strong>Execution authorization happens after strategy creation</strong><span>Save the algorithm first, open its LIVE TARGETS tab, then add and explicitly arm an eligible broker or Investment Group. The creation wizard never connects an account.</span><button type="button" onClick={() => setActiveTab("myStrategy")}>OPEN MY STRATEGY</button></div>;
    return <div className="strategy-primary-empty"><Database size={25} /><strong>Strategy logs are scoped to each runtime</strong><span>Open a strategy and select LOGS to inspect readable signals, fills, risk decisions and worker recovery events.</span><button type="button" onClick={() => setActiveTab("myStrategy")}>OPEN MY STRATEGY</button></div>;
  };

  return (
    <div className="strategy-lab">
      <div className="strategy-lab-head">
        <div>
          <strong>STRATEGY LAB</strong>
          <span>{config.symbol} / {config.exchangeLabel.toUpperCase()} / {config.timeframe}</span>
        </div>
        <button type="button" aria-label="Close Strategy Lab" onClick={onClose}><X size={18} /></button>
      </div>
      <StrategyTabs activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="strategy-lab-body">
        {renderActiveTab()}
      </div>
    </div>
  );
}
