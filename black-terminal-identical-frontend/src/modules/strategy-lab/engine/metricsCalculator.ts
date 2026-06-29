import type { DrawdownPoint, EquityPoint, PerformanceMetrics, PeriodBreakdown, TradeResult } from "../types/backtest.types";

function emptyBreakdown(): PeriodBreakdown[] {
  return [];
}

export function buildDrawdownCurve(equityCurve: EquityPoint[]): DrawdownPoint[] {
  let peak = equityCurve[0]?.equity ?? 0;
  return equityCurve.map((point) => {
    peak = Math.max(peak, point.equity);
    const drawdown = Math.max(0, peak - point.equity);
    return {
      time: point.time,
      drawdown,
      drawdownPercent: peak > 0 ? drawdown / peak : 0
    };
  });
}

function maxConsecutive(trades: TradeResult[], predicate: (trade: TradeResult) => boolean) {
  let current = 0;
  let best = 0;
  for (const trade of trades) {
    if (predicate(trade)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function periodKey(time: number, mode: "day" | "week" | "month") {
  const date = new Date(time * 1000);
  if (mode === "month") return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  if (mode === "week") {
    const firstDay = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const dayMs = 86400000;
    const week = Math.ceil((((date.getTime() - firstDay.getTime()) / dayMs) + firstDay.getUTCDay() + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function breakdown(trades: TradeResult[], mode: "day" | "week" | "month"): PeriodBreakdown[] {
  const groups = new Map<string, TradeResult[]>();
  for (const trade of trades) {
    const key = periodKey(trade.exitTime, mode);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }

  return [...groups.entries()].map(([key, items]) => {
    const grossProfit = items.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(items.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
    return {
      key,
      trades: items.length,
      pnl: items.reduce((sum, trade) => sum + trade.pnl, 0),
      winRate: items.length ? items.filter((trade) => trade.pnl > 0).length / items.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export function calculatePerformanceMetrics(
  trades: TradeResult[],
  equityCurve: EquityPoint[],
  initialCapital: number
): PerformanceMetrics {
  if (trades.length === 0) {
    return {
      netProfit: 0,
      grossProfit: 0,
      grossLoss: 0,
      winRate: 0,
      lossRate: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      riskRewardRatio: 0,
      expectancy: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      averageTradeDurationSeconds: 0,
      bestTrade: 0,
      worstTrade: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      recoveryFactor: 0,
      returnOnCapital: 0,
      longNetProfit: 0,
      shortNetProfit: 0,
      longWinRate: 0,
      shortWinRate: 0,
      dailyBreakdown: emptyBreakdown(),
      weeklyBreakdown: emptyBreakdown(),
      monthlyBreakdown: emptyBreakdown()
    };
  }

  const winners = trades.filter((trade) => trade.pnl > 0);
  const losers = trades.filter((trade) => trade.pnl < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLossSigned = losers.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(grossLossSigned);
  const netProfit = grossProfit - grossLoss;
  const drawdowns = buildDrawdownCurve(equityCurve);
  const maxDrawdownPoint = drawdowns.reduce((max, point) => point.drawdown > max.drawdown ? point : max, drawdowns[0] ?? { drawdown: 0, drawdownPercent: 0, time: 0 });
  const returns = equityCurve.slice(1).map((point, index) => {
    const previous = equityCurve[index]?.equity ?? point.equity;
    return previous ? (point.equity - previous) / previous : 0;
  });
  const negativeReturns = returns.filter((value) => value < 0);
  const returnStdDev = standardDeviation(returns);
  const downsideStdDev = standardDeviation(negativeReturns);
  const meanReturn = average(returns);
  const longs = trades.filter((trade) => trade.direction === "long");
  const shorts = trades.filter((trade) => trade.direction === "short");

  return {
    netProfit,
    grossProfit,
    grossLoss,
    winRate: winners.length / trades.length,
    lossRate: losers.length / trades.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    averageWin: average(winners.map((trade) => trade.pnl)),
    averageLoss: average(losers.map((trade) => trade.pnl)),
    riskRewardRatio: Math.abs(average(losers.map((trade) => trade.pnl))) > 0
      ? average(winners.map((trade) => trade.pnl)) / Math.abs(average(losers.map((trade) => trade.pnl)))
      : 0,
    expectancy: netProfit / trades.length,
    maxDrawdown: maxDrawdownPoint.drawdown,
    maxDrawdownPercent: maxDrawdownPoint.drawdownPercent,
    sharpeRatio: returnStdDev > 0 ? (meanReturn / returnStdDev) * Math.sqrt(252) : undefined,
    sortinoRatio: downsideStdDev > 0 ? (meanReturn / downsideStdDev) * Math.sqrt(252) : undefined,
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    averageTradeDurationSeconds: average(trades.map((trade) => trade.durationSeconds)),
    bestTrade: Math.max(...trades.map((trade) => trade.pnl)),
    worstTrade: Math.min(...trades.map((trade) => trade.pnl)),
    consecutiveWins: maxConsecutive(trades, (trade) => trade.pnl > 0),
    consecutiveLosses: maxConsecutive(trades, (trade) => trade.pnl < 0),
    recoveryFactor: maxDrawdownPoint.drawdown > 0 ? netProfit / maxDrawdownPoint.drawdown : netProfit > 0 ? Infinity : 0,
    returnOnCapital: initialCapital > 0 ? netProfit / initialCapital : 0,
    longNetProfit: longs.reduce((sum, trade) => sum + trade.pnl, 0),
    shortNetProfit: shorts.reduce((sum, trade) => sum + trade.pnl, 0),
    longWinRate: longs.length ? longs.filter((trade) => trade.pnl > 0).length / longs.length : 0,
    shortWinRate: shorts.length ? shorts.filter((trade) => trade.pnl > 0).length / shorts.length : 0,
    dailyBreakdown: breakdown(trades, "day"),
    weeklyBreakdown: breakdown(trades, "week"),
    monthlyBreakdown: breakdown(trades, "month")
  };
}
