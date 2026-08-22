import type {
  StrategyRuntimeKind,
  StrategySettings,
} from "../types/strategy.types";

export type StrategyMarketType = "SPOT" | "FUTURES";
export type StrategyTargetType = "BROKER_ACCOUNT" | "INVESTMENT_GROUP";
export type StrategyTargetStatus =
  | "PENDING"
  | "READY"
  | "LIVE"
  | "PAUSED"
  | "DEGRADED"
  | "RISK_SUSPENDED"
  | "DISCONNECTING"
  | "DISCONNECTED"
  | "ERROR";
export type StrategyTradeAmountMode =
  | "PERCENT_ACCOUNT_EQUITY"
  | "PERCENT_STRATEGY_ALLOCATION"
  | "RISK_PERCENT"
  | "FIXED_USDT"
  | "FIXED_QUANTITY"
  | "VOLATILITY_TARGET";

export type StrategyAutomationDefinition = {
  runtimeKind: StrategyRuntimeKind;
  symbol: string;
  timeframe: string;
  marketType: StrategyMarketType;
  exchange: string;
  settings: StrategySettings;
  execution: Record<string, unknown>;
};

export type StrategyCapitalPolicy = {
  strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY" | "FIXED_USDT";
  strategyAllocationValue: number;
  tradeAmountMode: StrategyTradeAmountMode;
  tradeAmountValue: number;
  requestedLeverage?: number;
  maximumLeverage?: number;
  maximumPositionPercent: number;
  maximumExposurePercent: number;
  maximumDailyLoss: number;
  maximumDrawdown: number;
  maximumPositions: number;
  slippageBps: number;
  marginMode?: "CROSS" | "ISOLATED";
  quoteAssetReservePercent?: number;
  maximumBaseAssetExposurePercent?: number;
};

export type StrategySummary = {
  id: string;
  name: string;
  runtimeKind: StrategyRuntimeKind;
  symbol: string;
  timeframe: string;
  marketType: StrategyMarketType;
  exchange: string;
  currentVersion: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type StrategyPaperAccount = {
  id: string;
  strategyId: string;
  strategyVersion: number;
  marketType: StrategyMarketType;
  status: string;
  demoEquity: number;
  availableBalance: number;
  usedStrategyCapital: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  funding: number;
  capitalPolicyVersion: number;
  rowVersion: number;
  capitalPolicy: StrategyCapitalPolicy;
  maximumDrawdownPercent: number;
  preview: {
    allocatedStrategyCapital: number;
    entryCapital: number;
    requestedLeverage?: number;
    effectiveLeverage: number;
    estimatedNotional: number;
    estimatedMargin: number;
    remainingReserve: number;
    quoteAssetReserve?: number;
    maximumBaseAssetExposure?: number;
  };
  updatedAt: string;
};

export type StrategyTargetBinding = {
  id: string;
  strategyId: string;
  strategyVersion: number;
  slotIndex: number;
  targetType: StrategyTargetType;
  targetId: string;
  targetLabel?: string;
  targetProvider?: string;
  connectionId?: string;
  accountId?: string;
  groupId?: string;
  marketType: StrategyMarketType;
  status: StrategyTargetStatus;
  capitalPolicyVersion: number;
  capitalPolicy: StrategyCapitalPolicy;
  validation: { eligible?: boolean; reasons?: string[]; checkedAt?: string };
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  armedAt?: string;
};

export type StrategyTargetSnapshot = {
  bindingId: string;
  slotIndex: number;
  timestamp: number;
  freshness: "LIVE" | "STALE" | "DEGRADED" | "UNAVAILABLE";
  equity: number;
  availableBalance: number;
  allocatedStrategyCapital: number;
  usedStrategyCapital: number;
  freeStrategyCapital: number;
  requestedLeverage?: number;
  effectiveLeverage?: number;
  effectiveLeverageRange?: [number, number];
  members?: number;
  eligibleMembers?: number;
  pausedMembers?: number;
  degradedMembers?: number;
  openPositions: number;
  openOrders: number;
  walletBalance?: number;
  marginUsed?: number;
  marginUtilization?: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  returnPercent?: number;
  currentDrawdownPercent: number;
  maximumDrawdownPercent: number;
  winRate?: number;
  profitFactor?: number | null;
  tradeCount?: number;
  sharpe?: number;
  sortino?: number;
  calmar?: number;
  strategyState: string;
  connectionHealth: string;
  protectionHealth: string;
};

export type StrategyWorkspace = {
  strategy: StrategySummary & {
    definition: StrategyAutomationDefinition;
    globalCapitalPolicy: StrategyCapitalPolicy;
  };
  paper: StrategyPaperAccount | null;
  bindings: StrategyTargetBinding[];
  snapshots: StrategyTargetSnapshot[];
  runtime: {
    state: string;
    lastClosedCandleAt?: string;
    lastSignalAt?: string;
    lastHeartbeatAt?: string;
    safeErrorCode?: string;
  } | null;
  audit: Array<{
    id: number;
    event_type: string;
    severity: string;
    message: string;
    safe_metadata: Record<string, unknown>;
    created_at: string;
    binding_id?: string;
  }>;
};

export type EligibleBrokerTarget = {
  targetId: string;
  targetType: "BROKER_ACCOUNT";
  provider: string;
  label: string;
  environment: string;
  marketCapabilities: string[];
  equity: number;
  availableBalance: number;
  connectionHealth: string;
  privateStreamHealth: string;
  reconciliationStatus: string;
  maximumLeverage: number;
  validation: { eligible: boolean; reasons: string[] };
};

export type EligibleGroupTarget = {
  targetId: string;
  targetType: "INVESTMENT_GROUP";
  label: string;
  activeAuthorizedMembers: number;
  connectedAllocatedEquity: number;
  copyTradingReadiness: string;
  blackCloudReadiness: string;
  riskState: string;
  pausedMembers: number;
  degradedMembers: number;
  validation: { eligible: boolean; reasons: string[] };
};
