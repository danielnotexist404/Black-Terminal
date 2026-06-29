import type { Candle } from "../../../chart-engine/types";
import type { BacktestConfig, BacktestResult, ExitReason, TradeDirection, TradeResult } from "../types/backtest.types";
import type { StrategySignal } from "../types/strategy.types";
import { calculateFees, calculateFundingCost, calculatePositionSize, estimateRoundTripSlippage, executionPrice } from "./executionModel";
import { buildDrawdownCurve, calculatePerformanceMetrics } from "./metricsCalculator";
import { classifyMarketRegime, sessionForTimestamp } from "./regimeAnalyzer";

type OpenPosition = {
  id: string;
  direction: TradeDirection;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  initialRiskPerUnit: number;
  entryFee: number;
  signalName: string;
  marketRegime: string;
  session: string;
  partialExitCount: number;
  realizedPartialPnl: number;
};

function dateKey(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function signFor(direction: TradeDirection) {
  return direction === "long" ? 1 : -1;
}

function shouldStop(position: OpenPosition, candle: Candle) {
  if (position.stopLoss === undefined) return false;
  return position.direction === "long" ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
}

function shouldTakeProfit(position: OpenPosition, candle: Candle) {
  if (position.takeProfit === undefined) return false;
  return position.direction === "long" ? candle.high >= position.takeProfit : candle.low <= position.takeProfit;
}

function closePosition(
  position: OpenPosition,
  candle: Candle,
  referencePrice: number,
  reason: ExitReason,
  equityBeforeClose: number,
  config: BacktestConfig
): { trade: TradeResult; equity: number } {
  const exitPrice = executionPrice(referencePrice, candle, position.direction, "exit", config);
  const notional = position.entryPrice * position.quantity;
  const exitNotional = exitPrice * position.quantity;
  const exitFee = calculateFees(exitNotional, config);
  const fundingCost = calculateFundingCost(notional, position.entryTime, candle.time, config);
  const grossPnl = (exitPrice - position.entryPrice) * position.quantity * signFor(position.direction);
  const pnl = grossPnl + position.realizedPartialPnl - position.entryFee - exitFee - fundingCost;
  const rMultiple = position.initialRiskPerUnit > 0
    ? grossPnl / (position.initialRiskPerUnit * position.quantity)
    : 0;
  const trade: TradeResult = {
    id: position.id,
    symbol: config.symbol,
    direction: position.direction,
    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    exitTime: candle.time,
    exitPrice,
    quantity: position.quantity,
    notional,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    fees: position.entryFee + exitFee,
    slippage: estimateRoundTripSlippage(config),
    fundingCost,
    pnl,
    pnlPercent: notional > 0 ? pnl / notional : 0,
    rMultiple,
    exitReason: reason,
    durationSeconds: candle.time - position.entryTime,
    signalName: position.signalName,
    marketRegime: position.marketRegime,
    session: position.session,
    partialExitCount: position.partialExitCount
  };
  return { trade, equity: equityBeforeClose + pnl };
}

function updateTrailingRisk(position: OpenPosition, candle: Candle, config: BacktestConfig) {
  const trailingPercent = config.strategySettings.trailingStopPercent ?? 0;
  if (trailingPercent > 0) {
    const distance = candle.close * trailingPercent / 100;
    if (position.direction === "long") {
      position.stopLoss = Math.max(position.stopLoss ?? 0, candle.high - distance);
    } else {
      position.stopLoss = Math.min(position.stopLoss ?? Number.POSITIVE_INFINITY, candle.low + distance);
    }
  }

  const breakEvenAtR = config.strategySettings.breakEvenAtR ?? 0;
  if (breakEvenAtR > 0 && position.initialRiskPerUnit > 0) {
    const favorableMove = (candle.close - position.entryPrice) * signFor(position.direction);
    if (favorableMove >= position.initialRiskPerUnit * breakEvenAtR) {
      position.stopLoss = position.direction === "long"
        ? Math.max(position.stopLoss ?? 0, position.entryPrice)
        : Math.min(position.stopLoss ?? Number.POSITIVE_INFINITY, position.entryPrice);
    }
  }
}

function maybeApplyPartialExit(position: OpenPosition, candle: Candle, config: BacktestConfig) {
  const partialAtR = config.strategySettings.partialExitAtR ?? 0;
  const partialPercent = Math.max(0, Math.min(100, config.strategySettings.partialExitPercent ?? 0)) / 100;
  if (position.partialExitCount > 0 || partialAtR <= 0 || partialPercent <= 0 || position.initialRiskPerUnit <= 0) return;

  const targetMove = position.initialRiskPerUnit * partialAtR;
  const touched = position.direction === "long"
    ? candle.high >= position.entryPrice + targetMove
    : candle.low <= position.entryPrice - targetMove;
  if (!touched) return;

  const closedQuantity = position.quantity * partialPercent;
  const exitPrice = position.entryPrice + targetMove * signFor(position.direction);
  const grossPnl = targetMove * closedQuantity;
  position.realizedPartialPnl += grossPnl - calculateFees(exitPrice * closedQuantity, config);
  position.quantity -= closedQuantity;
  position.partialExitCount += 1;
}

export function runBacktest(candles: Candle[], signals: StrategySignal[], config: BacktestConfig): BacktestResult {
  const warnings: string[] = [];
  if (candles.length < 20) {
    warnings.push("Not enough historical candles for a reliable backtest.");
  }
  if (!config.useBidAskExecution) {
    warnings.push("Bid/ask execution disabled. Results may be optimistic.");
  }

  const startTime = config.startDate ? Math.floor(new Date(config.startDate).getTime() / 1000) : 0;
  const endTime = config.endDate ? Math.floor(new Date(config.endDate).getTime() / 1000) : Number.POSITIVE_INFINITY;
  const signalByTime = new Map<number, StrategySignal[]>();
  signals.forEach((signal) => {
    signalByTime.set(signal.timestamp, [...(signalByTime.get(signal.timestamp) ?? []), signal]);
  });

  let equity = config.initialCapital;
  let peakEquity = equity;
  let openPosition: OpenPosition | undefined;
  let halted = false;
  let consecutiveLosses = 0;
  const trades: TradeResult[] = [];
  const equityCurve = candles
    .filter((candle) => candle.time >= startTime && candle.time <= endTime)
    .slice(0, 1)
    .map((candle) => ({ time: candle.time, equity, realizedPnl: 0 }));
  const tradesPerDay = new Map<string, number>();
  const dailyPnl = new Map<string, number>();

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    if (!candle || candle.time < startTime || candle.time > endTime) continue;
    if (halted) {
      equityCurve.push({ time: candle.time, equity, realizedPnl: equity - config.initialCapital });
      continue;
    }

    if (openPosition) {
      updateTrailingRisk(openPosition, candle, config);
      maybeApplyPartialExit(openPosition, candle, config);

      let exitReason: ExitReason | undefined;
      let referencePrice = candle.close;
      if (shouldStop(openPosition, candle)) {
        exitReason = openPosition.stopLoss === openPosition.entryPrice ? "breakEven" : "stopLoss";
        referencePrice = openPosition.stopLoss ?? candle.close;
      } else if (shouldTakeProfit(openPosition, candle)) {
        exitReason = "takeProfit";
        referencePrice = openPosition.takeProfit ?? candle.close;
      }

      const exitSignal = signalByTime.get(candle.time)?.find((signal) => signal.exit || (signal.entry && signal.direction !== openPosition?.direction));
      if (!exitReason && exitSignal) {
        exitReason = "signal";
        referencePrice = candle.close;
      }

      if (exitReason) {
        const closed = closePosition(openPosition, candle, referencePrice, exitReason, equity, config);
        equity = closed.equity;
        trades.push(closed.trade);
        dailyPnl.set(dateKey(candle.time), (dailyPnl.get(dateKey(candle.time)) ?? 0) + closed.trade.pnl);
        consecutiveLosses = closed.trade.pnl < 0 ? consecutiveLosses + 1 : 0;
        openPosition = undefined;
      }
    }

    peakEquity = Math.max(peakEquity, equity);
    const drawdownPercent = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (config.maxDrawdown !== undefined && drawdownPercent >= config.maxDrawdown) {
      warnings.push("Max account drawdown stop triggered.");
      halted = true;
    }
    const currentDailyLoss = Math.min(0, dailyPnl.get(dateKey(candle.time)) ?? 0);
    if (config.maxDailyLoss !== undefined && Math.abs(currentDailyLoss) >= config.maxDailyLoss) {
      warnings.push("Max daily loss stop triggered.");
      halted = true;
    }
    if ((config.cooldownAfterLosses ?? 0) > 0 && consecutiveLosses >= (config.cooldownAfterLosses ?? 0)) {
      equityCurve.push({ time: candle.time, equity, realizedPnl: equity - config.initialCapital });
      continue;
    }

    const entrySignal = signalByTime.get(candle.time)?.find((signal) => signal.entry && (signal.direction === "long" || signal.direction === "short"));
    if (!openPosition && entrySignal && !halted) {
      const day = dateKey(candle.time);
      const dayCount = tradesPerDay.get(day) ?? 0;
      if (config.maxTradesPerDay !== undefined && dayCount >= config.maxTradesPerDay) {
        equityCurve.push({ time: candle.time, equity, realizedPnl: equity - config.initialCapital });
        continue;
      }

      const direction = entrySignal.direction as TradeDirection;
      const entryPrice = executionPrice(candle.close, candle, direction, "entry", config);
      const stopLoss = entrySignal.stopLoss ?? (direction === "long"
        ? entryPrice * (1 - config.strategySettings.stopLossPercent / 100)
        : entryPrice * (1 + config.strategySettings.stopLossPercent / 100));
      const takeProfit = entrySignal.takeProfit;
      const quantity = calculatePositionSize(equity, entryPrice, stopLoss, config);
      if (quantity > 0) {
        const notional = entryPrice * quantity;
        openPosition = {
          id: `T-${trades.length + 1}`,
          direction,
          entryTime: candle.time,
          entryPrice,
          quantity,
          stopLoss,
          takeProfit,
          initialRiskPerUnit: Math.abs(entryPrice - stopLoss),
          entryFee: calculateFees(notional, config),
          signalName: entrySignal.signalName ?? entrySignal.reason ?? "Strategy Entry",
          marketRegime: classifyMarketRegime(candles, index),
          session: sessionForTimestamp(candle.time),
          partialExitCount: 0,
          realizedPartialPnl: 0
        };
        tradesPerDay.set(day, dayCount + 1);
      }
    }

    equityCurve.push({ time: candle.time, equity, realizedPnl: equity - config.initialCapital });
  }

  if (openPosition) {
    const last = candles[candles.length - 1];
    const closed = closePosition(openPosition, last, last.close, "endOfData", equity, config);
    equity = closed.equity;
    trades.push(closed.trade);
    equityCurve.push({ time: last.time, equity, realizedPnl: equity - config.initialCapital });
  }

  const drawdownCurve = buildDrawdownCurve(equityCurve);
  const metrics = calculatePerformanceMetrics(trades, equityCurve, config.initialCapital);

  return {
    trades,
    equityCurve,
    drawdownCurve,
    metrics,
    settings: {
      ...config.strategySettings,
      useBidAskExecution: config.useBidAskExecution,
      feeRate: config.feeRate,
      slippageTicks: config.slippageTicks,
      spreadBps: config.spreadBps
    },
    warnings,
    candlesTested: equityCurve.length
  };
}
