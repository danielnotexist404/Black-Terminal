import type { BacktestResult, PeriodBreakdown, TradeResult } from "../types/backtest.types";
import type { StrategyReviewInput } from "../types/ai.types";
import type { OptimizationResult } from "../types/optimization.types";

function groupBy<T>(items: T[], keyOf: (item: T) => string | undefined) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item) ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function summarizeTrades(trades: TradeResult[]) {
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  return {
    trades: trades.length,
    pnl,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0
  };
}

function sortPeriods(periods: PeriodBreakdown[], direction: "best" | "worst") {
  return [...periods]
    .sort((a, b) => direction === "best" ? b.pnl - a.pnl : a.pnl - b.pnl)
    .slice(0, 5);
}

export function buildStrategyReviewInput(
  result: BacktestResult,
  optimizationResults: OptimizationResult[] = []
): StrategyReviewInput {
  const bySession = [...groupBy(result.trades, (trade) => trade.session).entries()].map(([key, trades]) => ({
    session: key,
    ...summarizeTrades(trades)
  }));
  const byRegime = [...groupBy(result.trades, (trade) => trade.marketRegime).entries()].map(([key, trades]) => ({
    regime: key,
    ...summarizeTrades(trades)
  }));
  const drawdownClusters = result.drawdownCurve
    .filter((point) => point.drawdownPercent > result.metrics.maxDrawdownPercent * 0.65)
    .slice(0, 12)
    .map((point) => ({ time: point.time, drawdown: point.drawdown, drawdownPercent: point.drawdownPercent }));

  return {
    metrics: result.metrics,
    tradeDistribution: {
      longNetProfit: result.metrics.longNetProfit,
      shortNetProfit: result.metrics.shortNetProfit,
      longWinRate: result.metrics.longWinRate,
      shortWinRate: result.metrics.shortWinRate,
      exitReasons: [...groupBy(result.trades, (trade) => trade.exitReason).entries()].map(([reason, trades]) => ({
        reason,
        ...summarizeTrades(trades)
      }))
    },
    worstPeriods: sortPeriods(result.metrics.dailyBreakdown, "worst"),
    bestPeriods: sortPeriods(result.metrics.dailyBreakdown, "best"),
    sessionPerformance: bySession,
    regimePerformance: byRegime,
    drawdownClusters,
    optimizationResults: optimizationResults.slice(0, 12).map((item) => ({
      parameters: item.parameters,
      netProfit: item.backtest.metrics.netProfit,
      profitFactor: item.backtest.metrics.profitFactor,
      maxDrawdown: item.backtest.metrics.maxDrawdown,
      robustnessScore: item.robustnessScore,
      overfitWarning: item.overfitWarning
    })),
    tradeSamples: [
      ...result.trades.filter((trade) => trade.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 5),
      ...result.trades.filter((trade) => trade.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 5)
    ].map((trade) => ({
      id: trade.id,
      direction: trade.direction,
      pnl: trade.pnl,
      rMultiple: trade.rMultiple,
      exitReason: trade.exitReason,
      session: trade.session,
      marketRegime: trade.marketRegime
    }))
  };
}
