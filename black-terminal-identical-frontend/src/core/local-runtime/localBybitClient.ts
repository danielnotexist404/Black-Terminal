import { invoke } from "@tauri-apps/api/core";

export type LocalBybitEnvironment = "MAINNET" | "DEMO" | "TESTNET";

export type LocalBybitInstrumentRules = {
  symbol: string;
  status: string;
  minLeverage: string;
  maxLeverage: string;
  leverageStep: string;
  tickSize: string;
  quantityStep: string;
  minQuantity: string;
  maxMarketQuantity: string;
  maxLimitQuantity: string;
  minNotional: string;
};

export type LocalBybitAccountSnapshot = {
  accountId: string;
  environment: LocalBybitEnvironment;
  capturedAt: number;
  latencyMs: number;
  serverTime: number;
  clockSkewMs: number;
  totalEquityUsd: string;
  totalWalletBalanceUsd: string;
  totalAvailableBalanceUsd: string;
  totalInitialMarginUsd: string;
  totalMaintenanceMarginUsd: string;
  totalPerpetualUnrealizedPnlUsd: string;
  tradingEnabled: boolean;
  withdrawalEnabled: boolean;
  apiPermissions: Record<string, string[]>;
  wallet: Record<string, unknown>;
  positions: Record<string, unknown>;
  openOrders: Record<string, unknown>;
};

export type LocalBybitClockSample = {
  serverTimeMs: number;
  requestSentAt: number;
  responseReceivedAt: number;
  latencyMs: number;
};

export type LocalBybitOrderRequest = {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit";
  quantity: string;
  price?: string;
  reduceOnly: boolean;
  closeOnTrigger: boolean;
  positionIdx: 0 | 1 | 2;
  leverage?: string;
  orderLinkId: string;
  triggerPrice?: string;
  triggerDirection?: 1 | 2;
  triggerBy?: "LastPrice" | "MarkPrice" | "IndexPrice";
  takeProfit?: string;
  stopLoss?: string;
  mainnetConfirmed: boolean;
};

export type LocalBybitOrderReceipt = {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  orderId: string;
  orderLinkId: string;
  orderStatus: string;
  acceptedAt: number;
  reconciledAt: number;
  raw: Record<string, unknown> | null;
};

export function getLocalBybitInstrumentRules(environment: LocalBybitEnvironment, symbol: string) {
  return invoke<LocalBybitInstrumentRules>("bybit_local_instrument_rules", { environment, symbol });
}

export function sampleLocalBybitClock(environment: LocalBybitEnvironment = "MAINNET") {
  return invoke<LocalBybitClockSample>("bybit_local_clock_sample", { environment });
}

export function syncLocalBybitAccount(accountId: string, environment: LocalBybitEnvironment) {
  return invoke<LocalBybitAccountSnapshot>("bybit_local_sync_account", { accountId, environment });
}

export function setLocalBybitLeverage(request: {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  leverage: string;
  mainnetConfirmed: boolean;
}) {
  return invoke<LocalBybitInstrumentRules>("bybit_local_set_leverage", { request });
}

export function setLocalBybitTradingStop(request: {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  positionIdx: 0 | 1 | 2;
  takeProfit?: string;
  stopLoss?: string;
  trailingStop?: string;
  activePrice?: string;
  mainnetConfirmed: boolean;
}) {
  return invoke<Record<string, unknown>>("bybit_local_set_trading_stop", { request });
}

export function submitLocalBybitOrder(request: LocalBybitOrderRequest) {
  return invoke<LocalBybitOrderReceipt>("bybit_local_submit_order", { request });
}

export function placeLocalBybitPartialTakeProfits(request: {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  positionSide: "Buy" | "Sell";
  positionQuantity: string;
  positionIdx: 0 | 1 | 2;
  planId: string;
  levels: Array<{ price: string; percentage: string }>;
  triggerBy?: "LastPrice" | "MarkPrice" | "IndexPrice";
  mainnetConfirmed: boolean;
}) {
  return invoke<{
    planId: string;
    positionQuantity: string;
    protectedQuantity: string;
    unallocatedQuantity: string;
    orders: LocalBybitOrderReceipt[];
  }>("bybit_local_place_partial_take_profits", { request });
}

export function cancelLocalBybitOrder(request: {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  orderId: string;
  mainnetConfirmed: boolean;
}) {
  return invoke<LocalBybitOrderReceipt>("bybit_local_cancel_order", { request });
}

export function lookupLocalBybitOrder(request: {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  orderLinkId: string;
}) {
  return invoke<Record<string, unknown> | null>("bybit_local_lookup_order", { request });
}

export function amendLocalBybitOrder(request: {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  orderId: string;
  quantity?: string;
  price?: string;
  triggerPrice?: string;
  mainnetConfirmed: boolean;
}) {
  return invoke<LocalBybitOrderReceipt>("bybit_local_amend_order", { request });
}

export function reverseLocalBybitPosition(request: {
  accountId: string;
  environment: LocalBybitEnvironment;
  symbol: string;
  targetSide: "Buy" | "Sell";
  targetQuantity: string;
  leverage?: string;
  orderLinkId: string;
  mainnetConfirmed: boolean;
}) {
  return invoke<{ closeOrder: LocalBybitOrderReceipt; entryOrder: LocalBybitOrderReceipt }>("bybit_local_reverse_position", { request });
}

export function localBybitOrderLinkId(value: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
  if (normalized.length > 0 && normalized.length <= 36) return normalized;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const prefix = normalized.slice(0, 24).replace(/-+$/g, "") || "order";
  return `bt-${prefix}-${hash.toString(16).padStart(8, "0")}`.slice(0, 36);
}
