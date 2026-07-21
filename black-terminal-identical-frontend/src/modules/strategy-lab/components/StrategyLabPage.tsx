import { useEffect, useMemo, useState } from "react";
import { Bot, Database, FlaskConical, X } from "lucide-react";
import type { AdaptiveSwingStrategySettings, Candle } from "../../../chart-engine/types";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import { createAIStrategyReview } from "../ai/aiStrategyReview";
import { fetchStrategyLabCandles } from "../adapters/marketDataAdapter";
import { createStrategySignals } from "../adapters/signalAdapter";
import { runBacktest } from "../engine/backtestEngine";
import { runOptimization } from "../engine/optimizer";
import { buildStrategyReviewInput } from "../engine/tradeAnalyzer";
import { runWalkForward } from "../engine/walkForward";
import { createDefaultBacktestConfig } from "../state/strategyLabStore";
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
  marketSymbol: MarketSymbol;
  displaySymbol: string;
  exchangeLabel: string;
  timeframe: Timeframe;
  selectedStrategyKind: StrategyRuntimeKind;
  strategySelectionRevision: number;
  adaptiveSwingSettings?: AdaptiveSwingStrategySettings;
  onClose: () => void;
  onTradeSelect?: (trade: TradeResult) => void;
};

const defaultOptimizationSpace: OptimizationSpace = {
  swingLookback: { min: 16, max: 40, step: 4 },
  atrStopMultiplier: { min: 1, max: 2.2, step: 0.2 },
  takeProfitRatio: { min: 1.2, max: 3.5, step: 0.4 },
  minTrendQuality: { min: 0.18, max: 0.46, step: 0.04 }
};

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
  marketSymbol,
  displaySymbol,
  exchangeLabel,
  timeframe,
  selectedStrategyKind,
  strategySelectionRevision,
  adaptiveSwingSettings,
  onClose,
  onTradeSelect
}: StrategyLabPageProps) {
  const [activeTab, setActiveTab] = useState<StrategyLabTab>("overview");
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
  }, [adaptiveSwingSettings, displaySymbol, exchangeLabel, marketSymbol, selectedStrategyKind, timeframe]);

  useEffect(() => {
    if (strategySelectionRevision === 0) return;
    setActiveTab("backtest");
  }, [strategySelectionRevision]);

  const status = runState === "completed"
    ? `${result?.candlesTested.toLocaleString() ?? 0} BARS`
    : runState.toUpperCase().replace("-", " ");

  const run = async (nextTab: StrategyLabTab = "overview") => {
    setError(undefined);
    setRunState("loading-data");
    try {
      const history = await fetchStrategyLabCandles(marketSymbol, config.timeframe, config.startDate, config.endDate, 1800);
      setCandles(history);
      setRunState("running");
      const signals = createStrategySignals(config.strategyKind, history, config.symbol, config.strategySettings);
      const nextResult = runBacktest(history, signals, config);
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

  useEffect(() => {
    if (activeTab !== "trades" || result || runState !== "idle") return;
    void run("trades");
  }, [activeTab, result, runState]);

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
        setActiveTab("optimization");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setOptimizationBusy(false);
      }
    }, 20);
  };

  const wfSummary = useMemo(() => summarizeWalkForward(walkForward), [walkForward]);

  const renderActiveTab = () => {
    if (activeTab === "backtest") {
      return <BacktestPanel config={config} runState={runState} error={error} onConfigChange={setConfig} onRun={() => run()} />;
    }
    if (activeTab === "trades") {
      return <TradesTable trades={result?.trades ?? []} onTradeSelect={onTradeSelect} />;
    }
    if (activeTab === "equity") {
      return (
        <div className="strategy-split-grid">
          <EquityCurvePanel points={result?.equityCurve ?? []} />
          <PeriodPerformancePanel title="DAILY PNL" rows={result?.metrics.dailyBreakdown ?? []} />
          <PeriodPerformancePanel title="MONTHLY PERFORMANCE" rows={result?.metrics.monthlyBreakdown ?? []} />
        </div>
      );
    }
    if (activeTab === "drawdown") {
      return <DrawdownCurvePanel points={result?.drawdownCurve ?? []} />;
    }
    if (activeTab === "optimization") {
      return <OptimizationPanel space={optimizationSpace} results={optimizationResults} busy={optimizationBusy} onSpaceChange={setOptimizationSpace} onRun={runOptimizer} />;
    }
    if (activeTab === "heatmap") {
      return <HeatmapPanel results={optimizationResults} />;
    }
    if (activeTab === "aiReview") {
      return <AIReviewPanel review={review} />;
    }
    if (activeTab === "codeSuggestions") {
      return <CodeSuggestionsPanel suggestions={codeSuggestions} onChange={setCodeSuggestions} />;
    }
    if (activeTab === "forwardTest") {
      return <ForwardTestPanel result={result} symbol={displaySymbol} />;
    }
    return (
      <div className="strategy-dashboard-grid">
        <OverviewPanel result={result} status={status} />
        <div className="strategy-panel strategy-side-summary">
          <div className="strategy-panel-head"><span>RESEARCH STATE</span><b>{exchangeLabel.toUpperCase()}</b></div>
          <div className="strategy-kv-grid">
            <div><span>Symbol</span><strong>{displaySymbol}</strong></div>
            <div><span>Timeframe</span><strong>{timeframe}</strong></div>
            <div><span>Candles</span><strong>{candles.length.toLocaleString()}</strong></div>
            <div><span>Trades</span><strong>{result?.metrics.totalTrades ?? 0}</strong></div>
            <div><span>Net</span><strong>{result ? formatCurrency(result.metrics.netProfit) : "-"}</strong></div>
            <div><span>Return</span><strong>{result ? formatPercent(result.metrics.returnOnCapital) : "-"}</strong></div>
            <div><span>Robust Avg</span><strong>{formatNumber(optimizationResults.reduce((sum, item) => sum + item.robustnessScore, 0) / Math.max(1, optimizationResults.length), 1)}</strong></div>
            <div><span>WF Stability</span><strong>{formatPercent(wfSummary.stability)}</strong></div>
          </div>
          <button type="button" className="strategy-primary-button wide" onClick={() => run()}>
            <FlaskConical size={14} />
            RUN CURRENT MODEL
          </button>
          <button type="button" className="strategy-secondary-button wide" disabled={!result || optimizationBusy} onClick={runOptimizer}>
            <Database size={14} />
            RUN OPTIMIZATION
          </button>
          <button type="button" className="strategy-secondary-button wide" disabled={!result} onClick={() => setActiveTab("aiReview")}>
            <Bot size={14} />
            OPEN AI REVIEW
          </button>
          {error ? <div className="strategy-error">{error}</div> : null}
        </div>
        <EquityCurvePanel points={result?.equityCurve ?? []} />
        <DrawdownCurvePanel points={result?.drawdownCurve ?? []} />
      </div>
    );
  };

  return (
    <div className="strategy-lab">
      <div className="strategy-lab-head">
        <div>
          <strong>STRATEGY LAB</strong>
          <span>{displaySymbol} / {exchangeLabel.toUpperCase()} / {timeframe}</span>
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
