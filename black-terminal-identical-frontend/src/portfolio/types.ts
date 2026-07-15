import type { AccountConnection, Balance, OrderUpdate } from "../execution/types";
import type { ExchangeId } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";
import type { AccountRiskControls } from "../risk/types";

export type PortfolioAccount = AccountConnection & {
  accountName: string;
  status: "connected" | "degraded" | "offline" | "read-only";
  apiHealth: "healthy" | "warning" | "failed";
  latencyMs: number;
  balanceUsd: number;
  equityUsd: number;
  marginUsed: number;
  availableMargin: number;
  buyingPower: number;
  leverage: number;
  dailyPnl: number;
  monthlyPnl: number;
  openPositions: number;
  openOrders: number;
  riskControls: AccountRiskControls;
};

export type PortfolioSummary = {
  totalEquity: number;
  totalBalance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  dailyPnl: number;
  weeklyPnl: number;
  monthlyPnl: number;
  drawdownPct: number;
  marginUsed: number;
  availableMargin: number;
  buyingPower: number;
  leverage: number;
  riskScore: number;
};

export type PortfolioCurvePoint = {
  time: string;
  value: number;
};

export type PortfolioExposure = {
  label: string;
  value: number;
};

export type PortfolioSnapshot = {
  summary: PortfolioSummary;
  accounts: PortfolioAccount[];
  balances: Balance[];
  positions: PortfolioPosition[];
  orders: OrderUpdate[];
  orderSync?: Record<string, {
    network: string;
    requestedCategories: string[];
    successfulCategories: string[];
    failedCategories: Array<{ category: string; error: string }>;
    ordersPerCategory: Record<string, number>;
    duplicateRecordCount?: number;
    pagination?: Record<string, {
      pages: number;
      rawRecordCount: number;
      uniqueRecordCount: number;
      duplicateRecordCount: number;
      repeatedCursor: boolean;
      cursorLimitReached: boolean;
    } | null>;
    activeOrderCount: number;
    verified: boolean;
    stale: boolean;
    syncedAt: number;
    latencyMs: number;
  }>;
  curves: {
    equity: PortfolioCurvePoint[];
    drawdown: PortfolioCurvePoint[];
    dailyReturns: PortfolioCurvePoint[];
    exposure: PortfolioExposure[];
  };
};

export type ExchangeConnectionDraft = {
  exchange: ExchangeId;
  accountName: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};
