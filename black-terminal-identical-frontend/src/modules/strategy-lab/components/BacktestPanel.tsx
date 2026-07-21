import { Play } from "lucide-react";
import type { BacktestConfig, BacktestRunState } from "../types/backtest.types";
import type { StrategyRuntimeKind, StrategySettings } from "../types/strategy.types";

type BacktestPanelProps = {
  config: BacktestConfig;
  runState: BacktestRunState;
  error?: string;
  onConfigChange: (config: BacktestConfig) => void;
  onRun: () => void;
};

function updateNumber(value: string, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const strategyOptions: { value: StrategyRuntimeKind; label: string }[] = [
  { value: "builtin-adaptive-swing", label: "Adaptive Swing Reversal" },
  { value: "builtin-ema-cross", label: "EMA Cross Baseline" },
  { value: "python-script", label: "Python Script (adapter pending)" },
  { value: "external-signals", label: "External Signals (adapter pending)" }
];

export function BacktestPanel({ config, runState, error, onConfigChange, onRun }: BacktestPanelProps) {
  const patch = (patchValue: Partial<BacktestConfig>) => onConfigChange({ ...config, ...patchValue });
  const patchSettings = (patchValue: Partial<StrategySettings>) => onConfigChange({
    ...config,
    strategySettings: {
      ...config.strategySettings,
      ...patchValue
    }
  });
  const busy = runState === "loading-data" || runState === "running";

  return (
    <div className="strategy-panel backtest-panel">
      <div className="strategy-panel-head">
        <span>BACKTEST CONFIG</span>
        <button type="button" className="strategy-primary-button" disabled={busy} onClick={onRun}>
          <Play size={14} />
          {busy ? "RUNNING" : "RUN BACKTEST"}
        </button>
      </div>
      <div className="strategy-form-grid">
        <label>
          Strategy Model
          <select value={config.strategyKind} onChange={(event) => patch({ strategyKind: event.target.value as StrategyRuntimeKind })}>
            {strategyOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Symbol
          <input value={config.symbol} readOnly />
        </label>
        <label>
          Timeframe
          <input value={config.timeframe} readOnly />
        </label>
        <label>
          Start
          <input type="date" value={config.startDate} onChange={(event) => patch({ startDate: event.target.value })} />
        </label>
        <label>
          End
          <input type="date" value={config.endDate} onChange={(event) => patch({ endDate: event.target.value })} />
        </label>
        <label>
          Initial Capital
          <input type="number" value={config.initialCapital} onChange={(event) => patch({ initialCapital: updateNumber(event.target.value, config.initialCapital) })} />
        </label>
        <label>
          Risk / Trade
          <input type="number" min={0} max={0.2} step={0.001} value={config.riskPerTrade} onChange={(event) => patch({ riskPerTrade: updateNumber(event.target.value, config.riskPerTrade) })} />
        </label>
        <label>
          Fee Rate
          <input type="number" min={0} step={0.0001} value={config.feeRate} onChange={(event) => patch({ feeRate: updateNumber(event.target.value, config.feeRate) })} />
        </label>
        <label>
          Spread Bps
          <input type="number" min={0} step={0.1} value={config.spreadBps} onChange={(event) => patch({ spreadBps: updateNumber(event.target.value, config.spreadBps) })} />
        </label>
        <label>
          Slippage Ticks
          <input type="number" min={0} value={config.slippageTicks} onChange={(event) => patch({ slippageTicks: updateNumber(event.target.value, config.slippageTicks) })} />
        </label>
        <label>
          Tick Size
          <input type="number" min={0.00000001} step={0.1} value={config.tickSize} onChange={(event) => patch({ tickSize: updateNumber(event.target.value, config.tickSize) })} />
        </label>
        <label>
          Max Trades / Day
          <input type="number" min={1} value={config.maxTradesPerDay ?? 8} onChange={(event) => patch({ maxTradesPerDay: updateNumber(event.target.value, config.maxTradesPerDay ?? 8) })} />
        </label>
        <label>
          Max Daily Loss
          <input type="number" min={0} value={config.maxDailyLoss ?? 0} onChange={(event) => patch({ maxDailyLoss: updateNumber(event.target.value, config.maxDailyLoss ?? 0) })} />
        </label>
        <label>
          Max Drawdown
          <input type="number" min={0} max={1} step={0.01} value={config.maxDrawdown ?? 0.2} onChange={(event) => patch({ maxDrawdown: updateNumber(event.target.value, config.maxDrawdown ?? 0.2) })} />
        </label>
        <label className="strategy-check-field">
          Bid/Ask Execution
          <input type="checkbox" checked={config.useBidAskExecution} onChange={(event) => patch({ useBidAskExecution: event.target.checked })} />
        </label>
      </div>
      <div className="strategy-subhead">STRATEGY SETTINGS</div>
      <div className="strategy-form-grid">
        <label>
          EMA Fast
          <input type="number" min={2} value={config.strategySettings.emaFastLength} onChange={(event) => patchSettings({ emaFastLength: updateNumber(event.target.value, config.strategySettings.emaFastLength) })} />
        </label>
        <label>
          EMA Slow
          <input type="number" min={3} value={config.strategySettings.emaSlowLength} onChange={(event) => patchSettings({ emaSlowLength: updateNumber(event.target.value, config.strategySettings.emaSlowLength) })} />
        </label>
        <label>
          Stop %
          <input type="number" min={0.05} step={0.05} value={config.strategySettings.stopLossPercent} onChange={(event) => patchSettings({ stopLossPercent: updateNumber(event.target.value, config.strategySettings.stopLossPercent) })} />
        </label>
        <label>
          TP Ratio
          <input type="number" min={0.1} step={0.1} value={config.strategySettings.takeProfitRatio} onChange={(event) => patchSettings({ takeProfitRatio: updateNumber(event.target.value, config.strategySettings.takeProfitRatio) })} />
        </label>
        <label>
          Trail %
          <input type="number" min={0} step={0.05} value={config.strategySettings.trailingStopPercent ?? 0} onChange={(event) => patchSettings({ trailingStopPercent: updateNumber(event.target.value, config.strategySettings.trailingStopPercent ?? 0) })} />
        </label>
        <label>
          Break Even R
          <input type="number" min={0} step={0.25} value={config.strategySettings.breakEvenAtR ?? 0} onChange={(event) => patchSettings({ breakEvenAtR: updateNumber(event.target.value, config.strategySettings.breakEvenAtR ?? 0) })} />
        </label>
        <label>
          Partial At R
          <input type="number" min={0} step={0.25} value={config.strategySettings.partialExitAtR ?? 0} onChange={(event) => patchSettings({ partialExitAtR: updateNumber(event.target.value, config.strategySettings.partialExitAtR ?? 0) })} />
        </label>
        <label>
          Partial %
          <input type="number" min={0} max={100} step={5} value={config.strategySettings.partialExitPercent ?? 0} onChange={(event) => patchSettings({ partialExitPercent: updateNumber(event.target.value, config.strategySettings.partialExitPercent ?? 0) })} />
        </label>
        {config.strategyKind === "builtin-adaptive-swing" && (
          <>
            <label>
              Swing Lookback
              <input type="number" min={8} value={config.strategySettings.swingLookback ?? 24} onChange={(event) => patchSettings({ swingLookback: updateNumber(event.target.value, config.strategySettings.swingLookback ?? 24) })} />
            </label>
            <label>
              Regime EMA
              <input type="number" min={34} value={config.strategySettings.regimeEmaLength ?? 200} onChange={(event) => patchSettings({ regimeEmaLength: updateNumber(event.target.value, config.strategySettings.regimeEmaLength ?? 200) })} />
            </label>
            <label>
              RSI Length
              <input type="number" min={5} value={config.strategySettings.rsiLength ?? 14} onChange={(event) => patchSettings({ rsiLength: updateNumber(event.target.value, config.strategySettings.rsiLength ?? 14) })} />
            </label>
            <label>
              RSI Oversold
              <input type="number" min={5} max={50} value={config.strategySettings.rsiOversold ?? 34} onChange={(event) => patchSettings({ rsiOversold: updateNumber(event.target.value, config.strategySettings.rsiOversold ?? 34) })} />
            </label>
            <label>
              RSI Overbought
              <input type="number" min={50} max={95} value={config.strategySettings.rsiOverbought ?? 66} onChange={(event) => patchSettings({ rsiOverbought: updateNumber(event.target.value, config.strategySettings.rsiOverbought ?? 66) })} />
            </label>
            <label>
              ATR Stop
              <input type="number" min={0.5} step={0.05} value={config.strategySettings.atrStopMultiplier ?? 1.35} onChange={(event) => patchSettings({ atrStopMultiplier: updateNumber(event.target.value, config.strategySettings.atrStopMultiplier ?? 1.35) })} />
            </label>
            <label>
              Retest ATR
              <input type="number" min={0.05} step={0.05} value={config.strategySettings.swingRetestAtr ?? 0.45} onChange={(event) => patchSettings({ swingRetestAtr: updateNumber(event.target.value, config.strategySettings.swingRetestAtr ?? 0.45) })} />
            </label>
            <label>
              Trend Quality
              <input type="number" min={0} max={1} step={0.02} value={config.strategySettings.minTrendQuality ?? 0.28} onChange={(event) => patchSettings({ minTrendQuality: updateNumber(event.target.value, config.strategySettings.minTrendQuality ?? 0.28) })} />
            </label>
            <label>
              Max Chop Ratio
              <input type="number" min={0.05} max={1} step={0.02} value={config.strategySettings.maxChopRatio ?? 0.58} onChange={(event) => patchSettings({ maxChopRatio: updateNumber(event.target.value, config.strategySettings.maxChopRatio ?? 0.58) })} />
            </label>
            <label>
              Min Volume X
              <input type="number" min={0} step={0.05} value={config.strategySettings.minVolumeMultiplier ?? 0.85} onChange={(event) => patchSettings({ minVolumeMultiplier: updateNumber(event.target.value, config.strategySettings.minVolumeMultiplier ?? 0.85) })} />
            </label>
          </>
        )}
      </div>
      {error ? <div className="strategy-error">{error}</div> : null}
    </div>
  );
}
