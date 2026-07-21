import { Activity } from "lucide-react";
import type { OptimizationResult, OptimizationSpace } from "../types/optimization.types";
import { formatCurrency, formatNumber, formatPercent } from "./format";

type OptimizationPanelProps = {
  space: OptimizationSpace;
  results: OptimizationResult[];
  busy: boolean;
  onSpaceChange: (space: OptimizationSpace) => void;
  onRun: () => void;
};

const labels: Record<string, string> = {
  emaFastLength: "EMA Fast",
  emaSlowLength: "EMA Slow",
  stopLossPercent: "Stop %",
  takeProfitRatio: "TP Ratio",
  swingLookback: "Swing Lookback",
  atrStopMultiplier: "ATR Stop",
  minTrendQuality: "Trend Quality",
  maxChopRatio: "Max Chop",
  rsiLength: "RSI Length"
};

export function OptimizationPanel({ space, results, busy, onSpaceChange, onRun }: OptimizationPanelProps) {
  const patch = (key: string, field: "min" | "max" | "step", value: number) => {
    onSpaceChange({
      ...space,
      [key]: {
        ...space[key],
        [field]: value
      }
    });
  };

  return (
    <div className="strategy-panel optimization-panel">
      <div className="strategy-panel-head">
        <span>PARAMETER OPTIMIZER</span>
        <button type="button" className="strategy-primary-button" disabled={busy} onClick={onRun}>
          <Activity size={14} />
          {busy ? "OPTIMIZING" : "RUN GRID"}
        </button>
      </div>
      <div className="optimizer-space">
        {Object.entries(space).map(([key, range]) => (
          <div key={key} className="optimizer-range">
            <strong>{labels[key] ?? key}</strong>
            <label>Min<input type="number" value={range.min} step={range.step} onChange={(event) => patch(key, "min", Number(event.target.value))} /></label>
            <label>Max<input type="number" value={range.max} step={range.step} onChange={(event) => patch(key, "max", Number(event.target.value))} /></label>
            <label>Step<input type="number" value={range.step} step={range.step} onChange={(event) => patch(key, "step", Number(event.target.value))} /></label>
          </div>
        ))}
      </div>
      <div className="strategy-table-wrap optimizer-results">
        <table className="strategy-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Params</th>
              <th>Net</th>
              <th>PF</th>
              <th>Win</th>
              <th>DD</th>
              <th>Sharpe</th>
              <th>Robust</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 ? (
              <tr><td colSpan={9} className="strategy-empty-cell">NO OPTIMIZATION RESULTS</td></tr>
            ) : results.map((result, index) => (
              <tr key={result.id} className={result.overfitWarning ? "loss" : "win"}>
                <td>{index + 1}</td>
                <td>{Object.entries(result.parameters).map(([key, value]) => `${labels[key] ?? key}:${value}`).join(" / ")}</td>
                <td>{formatCurrency(result.backtest.metrics.netProfit)}</td>
                <td>{formatNumber(result.backtest.metrics.profitFactor)}</td>
                <td>{formatPercent(result.backtest.metrics.winRate)}</td>
                <td>{formatCurrency(result.backtest.metrics.maxDrawdown)}</td>
                <td>{result.backtest.metrics.sharpeRatio ? formatNumber(result.backtest.metrics.sharpeRatio) : "-"}</td>
                <td>{formatNumber(result.robustnessScore, 1)}</td>
                <td>{result.overfitWarning ? "OVERFIT" : "OK"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
