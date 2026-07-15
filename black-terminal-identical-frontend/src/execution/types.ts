import { ExchangeId, MarketKind } from "../market-data/types";

export type TradingPermission =
  | "read-account"
  | "read-orders"
  | "read-positions"
  | "place-orders"
  | "cancel-orders"
  | "modify-orders"
  | "withdraw-disabled";

export type AccountConnection = {
  id: string;
  exchange: ExchangeId;
  label: string;
  permissions: TradingPermission[];
  isPaper: boolean;
  connectedAt: number;
  lastValidatedAt?: number;
};

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop-market" | "stop-limit" | "trailing-stop" | "bracket" | "chase-limit" | "twap" | "iceberg" | "pov" | "scaled" | "post-only";
export type TimeInForce = "gtc" | "ioc" | "fok";
export type OrderLifecycleState =
  | "created"
  | "validated"
  | "risk-approved"
  | "risk-rejected"
  | "allocated"
  | "submitted"
  | "accepted"
  | "working"
  | "partially-filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired"
  | "archived";

export type ExecutionSource =
  | "chart"
  | "order-ticket"
  | "hotkey"
  | "strategy"
  | "ai-assistant"
  | "capital-allocation"
  | "replay-engine"
  | "future-api"
  | "positions";

export type ExecutionDestination = "personal-portfolio" | "allocation-engine" | "simulation" | "replay" | "paper-trading";
export type SizingMethod = "quantity" | "contracts" | "coin" | "usd" | "portfolioPct" | "equityPct" | "riskPct" | "fixedDollarRisk";
export type MarginMode = "cross" | "isolated" | "portfolio";
export type TriggerSource = "last" | "mark" | "index";
export type VenueStrategyParameters = {
  durationSeconds?: number;
  intervalSeconds?: number;
  randomize?: boolean;
  triggerPrice?: number;
  maxChasePrice?: number;
  chaseDistance?: number;
  chasePercent?: number;
  subSize?: number;
  orderCount?: number;
  icebergPreference?: "maker" | "taker" | "offset" | "fixed";
  povMode?: "TradedVolume" | "OppositeSideLiquidity" | "SameSideLiquidity";
  participationRate?: number;
  referenceWindowSeconds?: number;
  depthReference?: number;
};

export type OrderRequest = {
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  marketKind: MarketKind;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  sizingMethod?: SizingMethod;
  limitPrice?: number;
  stopPrice?: number;
  referencePrice?: number;
  leverage?: number;
  marginMode?: MarginMode;
  takeProfit?: number;
  stopLoss?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  timeInForce?: TimeInForce;
  triggerBy?: TriggerSource;
  tpTriggerBy?: TriggerSource;
  slTriggerBy?: TriggerSource;
  tpslMode?: "full" | "partial";
  positionIdx?: number;
  slippageTolerancePercent?: number;
  strategyParameters?: VenueStrategyParameters;
  clientOrderId?: string;
  internalOrderId?: string;
  source?: ExecutionSource;
  destinations?: ExecutionDestination[];
};

export type OrderStatus =
  | "pending"
  | "accepted"
  | "working"
  | "partially-filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired";

export type OrderUpdate = {
  accountId: string;
  exchange: ExchangeId;
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  status: OrderStatus;
  filledQuantity: number;
  averageFillPrice?: number;
  reason?: string;
  time: number;
  internalId?: string;
  venueOrderId?: string;
  connectionId?: string;
  network?: string;
  category?: string;
  normalizedSymbol?: string;
  side?: OrderSide;
  type?: string;
  orderType?: string;
  price?: number;
  triggerPrice?: number;
  quantity?: number;
  leavesQuantity?: number;
  remainingQuantity?: number;
  timeInForce?: string;
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  positionIdx?: number;
  source?: "venue" | "black-terminal";
  ownership?: "external" | "black-terminal";
  externallyCreated?: boolean;
  createdTime?: number;
  updatedTime?: number;
};

export type ExecutionRequest = {
  internalOrderId: string;
  userId?: string;
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  marketKind: MarketKind;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  sizingMethod: SizingMethod;
  limitPrice?: number;
  stopPrice?: number;
  referencePrice?: number;
  timeInForce: TimeInForce;
  triggerBy?: TriggerSource;
  tpTriggerBy?: TriggerSource;
  slTriggerBy?: TriggerSource;
  tpslMode?: "full" | "partial";
  positionIdx?: number;
  slippageTolerancePercent?: number;
  strategyParameters?: VenueStrategyParameters;
  leverage?: number;
  marginMode?: MarginMode;
  takeProfit?: number;
  stopLoss?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  destinations: ExecutionDestination[];
  source: ExecutionSource;
  timestamp: number;
  parentOrderId?: string;
};

export type ExecutionReport = OrderUpdate & {
  internalOrderId: string;
  lifecycleState: OrderLifecycleState;
  latencyMs?: number;
  destination?: ExecutionDestination;
  diagnosticContext?: Record<string, unknown>;
};

export type ExecutionMatrixPreviewRow = {
  accountId: string;
  accountName: string;
  exchange: ExchangeId;
  allocationMethod: string;
  calculatedQuantity: number;
  estimatedMargin: number;
  estimatedFees: number;
  estimatedExposure: number;
  riskStatus: "pending" | "approved" | "blocked";
  validationStatus: "pending" | "valid" | "invalid";
  executionStatus: OrderLifecycleState;
  reasons: string[];
};

export type Position = {
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  side: "long" | "short" | "flat";
  quantity: number;
  entryPrice?: number;
  markPrice?: number;
  unrealizedPnl?: number;
  liquidationPrice?: number;
};

export type Balance = {
  accountId: string;
  exchange: ExchangeId;
  asset: string;
  free: number;
  locked: number;
  total: number;
  usdValue?: number;
};

export type ExecutionAdapter = {
  exchange: ExchangeId;
  connectAccount: (connection: AccountConnection) => Promise<void>;
  validateConnection: (connection: AccountConnection) => Promise<boolean>;
  placeOrder: (order: OrderRequest) => Promise<OrderUpdate>;
  cancelOrder: (accountId: string, orderId: string) => Promise<OrderUpdate>;
  getBalances: (accountId: string) => Promise<Balance[]>;
  getPositions: (accountId: string) => Promise<Position[]>;
};
