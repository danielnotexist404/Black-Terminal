import type { BacktestResult } from "../types/backtest.types";
import { formatCurrency, formatDuration, formatNumber, formatPercent } from "./format";

type OverviewPanelProps = {
  result?: BacktestResult;
  status: string;
};

const emptyMetrics = [
  "Net Profit",
  "Profit Factor",
  "Win Rate",
  "Max Drawdown",
  "Total Trades",
  "Expectancy",
  "Sharpe",
  "Recovery"
];

export function OverviewPanel({ result, status }: OverviewPanelProps) {
  const metrics = result?.metrics;
  const cards = metrics ? [
    { label: "Net Profit", value: formatCurrency(metrics.netProfit), hot: metrics.netProfit >= 0 },
    { label: "Gross Profit", value: formatCurrency(metrics.grossProfit) },
    { label: "Gross Loss", value: formatCurrency(metrics.grossLoss) },
    { label: "Win Rate", value: formatPercent(metrics.winRate), hot: metrics.winRate >= 0.5 },
    { label: "Profit Factor", value: formatNumber(metrics.profitFactor), hot: metrics.profitFactor >= 1.25 },
    { label: "Average Win", value: formatCurrency(metrics.averageWin) },
    { label: "Average Loss", value: formatCurrency(metrics.averageLoss) },
    { label: "Risk/Reward", value: formatNumber(metrics.riskRewardRatio) },
    { label: "Expectancy", value: formatCurrency(metrics.expectancy), hot: metrics.expectancy >= 0 },
    { label: "Max Drawdown", value: formatCurrency(metrics.maxDrawdown), danger: metrics.maxDrawdownPercent > 0.18 },
    { label: "Max DD %", value: formatPercent(metrics.maxDrawdownPercent), danger: metrics.maxDrawdownPercent > 0.18 },
    { label: "Sharpe", value: metrics.sharpeRatio === undefined ? "-" : formatNumber(metrics.sharpeRatio), hot: (metrics.sharpeRatio ?? 0) > 1 },
    { label: "Sortino", value: metrics.sortinoRatio === undefined ? "-" : formatNumber(metrics.sortinoRatio), hot: (metrics.sortinoRatio ?? 0) > 1 },
    { label: "Total Trades", value: String(metrics.totalTrades) },
    { label: "Winning Trades", value: String(metrics.winningTrades), hot: metrics.winningTrades > metrics.losingTrades },
    { label: "Losing Trades", value: String(metrics.losingTrades), danger: metrics.losingTrades > metrics.winningTrades },
    { label: "Avg Duration", value: formatDuration(metrics.averageTradeDurationSeconds) },
    { label: "Best Trade", value: formatCurrency(metrics.bestTrade), hot: true },
    { label: "Worst Trade", value: formatCurrency(metrics.worstTrade), danger: true },
    { label: "Consec Wins", value: String(metrics.consecutiveWins), hot: true },
    { label: "Consec Losses", value: String(metrics.consecutiveLosses), danger: metrics.consecutiveLosses >= 3 },
    { label: "Recovery", value: formatNumber(metrics.recoveryFactor), hot: metrics.recoveryFactor > 1 },
    { label: "Return", value: formatPercent(metrics.returnOnCapital), hot: metrics.returnOnCapital > 0 },
    { label: "Long / Short PnL", value: `${formatCurrency(metrics.longNetProfit)} / ${formatCurrency(metrics.shortNetProfit)}` }
  ] : emptyMetrics.map((label) => ({ label, value: "-" }));

  return (
    <div className="strategy-panel overview-panel">
      <div className="strategy-panel-head">
        <span>PERFORMANCE</span>
        <b>{status}</b>
      </div>
      <div className="strategy-metric-grid">
        {cards.map((card) => (
          <div key={card.label} className={`strategy-metric-card${card.hot ? " hot" : ""}${card.danger ? " danger" : ""}`}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </div>
        ))}
      </div>
      {result?.warnings.length ? (
        <div className="strategy-warnings">
          {result.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
    </div>
  );
}
