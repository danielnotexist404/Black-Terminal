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
export type OrderType = "market" | "limit" | "stop-market" | "stop-limit" | "post-only";
export type TimeInForce = "gtc" | "ioc" | "fok";

export type OrderRequest = {
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  marketKind: MarketKind;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  timeInForce?: TimeInForce;
  clientOrderId?: string;
};

export type OrderStatus =
  | "pending"
  | "accepted"
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
