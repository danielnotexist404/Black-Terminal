export type AccountRiskControls = {
  maxLeverage: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
  maxPortfolioExposureUsd: number;
  allowedSymbols: string[];
  readOnlyMode: boolean;
  tradingEnabled: boolean;
  emergencyStop: boolean;
};

export type RiskCheckResult = {
  status: "approved" | "blocked" | "warning";
  reasons: string[];
};

export const defaultRiskControls: AccountRiskControls = {
  maxLeverage: 5,
  maxPositionUsd: 25_000,
  maxDailyLossUsd: 2_500,
  maxPortfolioExposureUsd: 100_000,
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  readOnlyMode: false,
  tradingEnabled: false,
  emergencyStop: false
};
