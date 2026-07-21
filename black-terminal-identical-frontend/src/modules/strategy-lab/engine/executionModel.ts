import type { Candle } from "../../../chart-engine/types";
import type { BacktestConfig, TradeDirection } from "../types/backtest.types";

export type ExecutionSide = "entry" | "exit";

export function spreadForCandle(candle: Candle, config: BacktestConfig) {
  const configuredSpread = candle.close * Math.max(0, config.spreadBps) / 10000;
  return config.useBidAskExecution ? configuredSpread : 0;
}

export function executionPrice(
  referencePrice: number,
  candle: Candle,
  direction: TradeDirection,
  side: ExecutionSide,
  config: BacktestConfig
) {
  const halfSpread = spreadForCandle(candle, config) / 2;
  const slippage = Math.max(0, config.slippageTicks) * Math.max(0.00000001, config.tickSize);
  const longPaysAsk = direction === "long" && side === "entry";
  const shortPaysAsk = direction === "short" && side === "exit";
  const sign = longPaysAsk || shortPaysAsk ? 1 : -1;
  return Math.max(0.00000001, referencePrice + sign * halfSpread + sign * slippage);
}

export function estimateRoundTripSlippage(config: BacktestConfig) {
  return Math.max(0, config.slippageTicks) * Math.max(0.00000001, config.tickSize) * 2;
}

export function calculatePositionSize(
  equity: number,
  entryPrice: number,
  stopLoss: number | undefined,
  config: BacktestConfig
) {
  const riskBudget = equity * Math.max(0, config.riskPerTrade);
  const stopDistance = stopLoss ? Math.abs(entryPrice - stopLoss) : entryPrice * 0.01;
  if (riskBudget <= 0 || stopDistance <= 0) return 0;

  const riskSizedQuantity = riskBudget / stopDistance;
  const maxLeverage = Math.max(0.1, config.maxLeverage ?? 3);
  const leverageCapQuantity = (equity * maxLeverage) / entryPrice;
  return Math.max(0, Math.min(riskSizedQuantity, leverageCapQuantity));
}

export function calculateFees(notional: number, config: BacktestConfig) {
  return Math.abs(notional) * Math.max(0, config.feeRate);
}

export function calculateFundingCost(notional: number, entryTime: number, exitTime: number, config: BacktestConfig) {
  const rate = config.fundingRatePerDay ?? 0;
  if (!rate) return 0;
  const days = Math.max(0, exitTime - entryTime) / 86400;
  return Math.abs(notional) * rate * days;
}
