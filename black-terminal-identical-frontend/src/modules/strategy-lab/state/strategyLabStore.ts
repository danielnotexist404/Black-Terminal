import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import type { BacktestConfig } from "../types/backtest.types";
import { defaultStrategySettings } from "../types/strategy.types";

export function createDefaultBacktestConfig(
  marketSymbol: MarketSymbol,
  displaySymbol: string,
  exchangeLabel: string,
  timeframe: Timeframe
): BacktestConfig {
  const end = new Date();
  const start = new Date(end.getTime() - 1000 * 60 * 60 * 24 * 14);

  return {
    symbol: displaySymbol,
    rawSymbol: marketSymbol.rawSymbol,
    exchange: marketSymbol.exchange,
    exchangeLabel,
    marketKind: marketSymbol.marketKind,
    timeframe,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    initialCapital: 10000,
    riskPerTrade: 0.01,
    feeRate: 0.0004,
    slippageTicks: 2,
    tickSize: 0.1,
    spreadBps: 1.5,
    useBidAskExecution: true,
    maxTradesPerDay: 8,
    maxDailyLoss: 250,
    maxDrawdown: 0.2,
    maxOpenPositions: 1,
    maxLeverage: 3,
    cooldownAfterLosses: 3,
    disableOnHighSpreadBps: 8,
    disableOnLowLiquidity: true,
    disableOnAbnormalVolatility: true,
    fundingRatePerDay: 0,
    strategyKind: "builtin-adaptive-swing",
    strategySettings: defaultStrategySettings
  };
}
