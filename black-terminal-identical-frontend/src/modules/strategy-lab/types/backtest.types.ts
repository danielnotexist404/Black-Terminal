import type { ExchangeId, MarketKind, Timeframe } from "../../../market-data/types";
import type { StrategyRuntimeKind, StrategySettings } from "./strategy.types";

export type TradeDirection = "long" | "short";
export type ExitReason =
  | "signal"
  | "stopLoss"
  | "takeProfit"
  | "trailingStop"
  | "breakEven"
  | "partialExit"
  | "dailyLossStop"
  | "drawdownStop"
  | "sessionClose"
  | "endOfData";

export type BacktestConfig = {
  symbol: string;
  rawSymbol: string;
  exchange: ExchangeId;
  exchangeLabel: string;
  marketKind: MarketKind;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  initialCapital: number;
  riskPerTrade: number;
  feeRate: number;
  slippageTicks: number;
  tickSize: number;
  spreadBps: number;
  useBidAskExecution: boolean;
  maxTradesPerDay?: number;
  maxDailyLoss?: number;
  maxDrawdown?: number;
  maxOpenPositions?: number;
  maxLeverage?: number;
  cooldownAfterLosses?: number;
  disableOnHighSpreadBps?: number;
  disableOnLowLiquidity?: boolean;
  disableOnAbnormalVolatility?: boolean;
  fundingRatePerDay?: number;
  strategyKind: StrategyRuntimeKind;
  strategySettings: StrategySettings;
};

export type TradeResult = {
  id: string;
  symbol: string;
  direction: TradeDirection;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  stopLoss?: number;
  takeProfit?: number;
  fees: number;
  slippage: number;
  fundingCost: number;
  pnl: number;
  pnlPercent: number;
  rMultiple: number;
  exitReason: ExitReason;
  durationSeconds: number;
  signalName: string;
  marketRegime?: string;
  session?: string;
  partialExitCount: number;
};

export type EquityPoint = {
  time: number;
  equity: number;
  realizedPnl: number;
};

export type DrawdownPoint = {
  time: number;
  drawdown: number;
  drawdownPercent: number;
};

export type PeriodBreakdown = {
  key: string;
  trades: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
};

export type PerformanceMetrics = {
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  winRate: number;
  lossRate: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  riskRewardRatio: number;
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio?: number;
  sortinoRatio?: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  averageTradeDurationSeconds: number;
  bestTrade: number;
  worstTrade: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  recoveryFactor: number;
  returnOnCapital: number;
  longNetProfit: number;
  shortNetProfit: number;
  longWinRate: number;
  shortWinRate: number;
  dailyBreakdown: PeriodBreakdown[];
  weeklyBreakdown: PeriodBreakdown[];
  monthlyBreakdown: PeriodBreakdown[];
};

export type BacktestResult = {
  trades: TradeResult[];
  equityCurve: EquityPoint[];
  drawdownCurve: DrawdownPoint[];
  metrics: PerformanceMetrics;
  settings: Record<string, unknown>;
  warnings: string[];
  candlesTested: number;
};

export type BacktestRunState = "idle" | "loading-data" | "running" | "completed" | "failed";
