import type { ExchangeId } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";
import type { RiskCheckResult } from "../risk/types";

export type AllocationMethod =
  | "equityPercentage"
  | "riskPercentage"
  | "fixedUsd"
  | "fixedQuantity"
  | "volatilityBased"
  | "portfolioWeight";

export type AllocationProfile = {
  id: string;
  name: string;
  method: AllocationMethod;
  value: number;
  maxExposureUsd: number;
};

export type CopyTradingFollower = {
  id: string;
  displayName: string;
  status: "active" | "paused" | "offline";
  equity: number;
  dailyPnl: number;
  monthlyPnl: number;
  connectedExchange: ExchangeId;
  positions: PortfolioPosition[];
  drawdownPct: number;
  allocationProfile: AllocationProfile;
  connectionHealth: "healthy" | "warning" | "failed";
};

export type ExecutionMatrixRow = {
  accountId: string;
  accountName: string;
  exchange: ExchangeId;
  allocationMethod: AllocationMethod;
  calculatedQuantity: number;
  estimatedExposure: number;
  estimatedMargin: number;
  riskCheck: RiskCheckResult;
};
