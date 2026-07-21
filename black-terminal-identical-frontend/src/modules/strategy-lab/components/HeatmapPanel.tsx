import type { OptimizationResult } from "../types/optimization.types";
import { formatCurrency, formatNumber } from "./format";

type HeatmapPanelProps = {
  results: OptimizationResult[];
  xKey?: string;
  yKey?: string;
};

export function HeatmapPanel({ results, xKey = "emaFastLength", yKey = "stopLossPercent" }: HeatmapPanelProps) {
  const profits = results.map((result) => result.backtest.metrics.netProfit);
  const min = profits.length ? Math.min(...profits) : 0;
  const max = profits.length ? Math.max(...profits) : 0;
  const range = max - min || 1;

  return (
    <div className="strategy-panel heatmap-panel">
      <div className="strategy-panel-head">
        <span>ROBUSTNESS HEATMAP</span>
        <b>{xKey} / {yKey}</b>
      </div>
      {results.length === 0 ? (
        <div className="strategy-empty-state">RUN OPTIMIZATION</div>
      ) : (
        <div className="strategy-heatmap">
          {results.map((result) => {
            const normalized = (result.backtest.metrics.netProfit - min) / range;
            const alpha = 0.16 + normalized * 0.62;
            return (
              <div
                key={result.id}
                className={result.overfitWarning ? "heat-cell suspect" : "heat-cell"}
                style={{ backgroundColor: `rgba(${result.backtest.metrics.netProfit >= 0 ? "214, 40, 57" : "120, 126, 136"}, ${alpha})` }}
                title={`${formatCurrency(result.backtest.metrics.netProfit)} / Robust ${formatNumber(result.robustnessScore)}`}
              >
                <span>{result.parameters[xKey] ?? "-"}</span>
                <b>{result.parameters[yKey] ?? "-"}</b>
                <em>{formatNumber(result.robustnessScore, 0)}</em>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
