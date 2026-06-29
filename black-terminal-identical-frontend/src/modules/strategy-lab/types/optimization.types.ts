import type { BacktestResult } from "./backtest.types";

export type ParameterRange = {
  min: number;
  max: number;
  step: number;
};

export type OptimizationSpace = Record<string, ParameterRange>;

export type OptimizationSortKey =
  | "netProfit"
  | "profitFactor"
  | "maxDrawdown"
  | "sharpeRatio"
  | "winRate"
  | "robustnessScore";

export type OptimizationResult = {
  id: string;
  parameters: Record<string, number>;
  backtest: BacktestResult;
  robustnessScore: number;
  overfitWarning: boolean;
};

export type WalkForwardWindow = {
  id: string;
  trainStart: number;
  trainEnd: number;
  validateStart: number;
  validateEnd: number;
  bestParameters: Record<string, number>;
  inSample: BacktestResult;
  outOfSample: BacktestResult;
  stability: number;
  overfittingRisk: "Low" | "Medium" | "High";
};
