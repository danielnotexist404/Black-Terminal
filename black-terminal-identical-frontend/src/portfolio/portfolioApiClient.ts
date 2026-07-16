import { supabase } from "../lib/supabase";
import type { ConnectionRecord } from "../connectivity/types";
import type { ExecutionDestination, ExecutionSource, MarginMode, OrderType, OrderUpdate, SizingMethod, TriggerSource, VenueStrategyParameters } from "../execution/types";
import type { ExchangeId, MarketKind } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";
import { defaultRiskControls } from "../risk/types";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "./types";
import { blackCorePerformanceMonitor } from "../performance/performanceMonitor";

type ApiAccount = {
  id: string;
  exchange: ExchangeId;
  accountName: string;
  status: PortfolioAccount["status"];
  apiHealth: "healthy" | "warning" | "failed" | "unknown";
  latencyMs: number;
  permissions: PortfolioAccount["permissions"];
  tradingEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  riskControls?: PortfolioAccount["riskControls"] | null;
};

type ApiSnapshot = {
  summary: PortfolioSnapshot["summary"];
  accounts: ApiAccount[];
  balances: Array<{
    accountId: string;
    asset: string;
    free: number;
    locked: number;
    total: number;
    usdValue?: number | null;
  }>;
  positions: Array<Omit<PortfolioPosition, "openedAt"> & { openedAt?: string | number | null }>;
  orders: any[];
  orderSync?: PortfolioSnapshot["orderSync"];
};

export type PortfolioOrderDraft = {
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  marketKind: MarketKind;
  side: "buy" | "sell";
  orderType: OrderType;
  quantity: number;
  quantityMode?: string;
  sizingMethod?: SizingMethod;
  referencePrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  leverage?: number;
  marginMode?: MarginMode;
  source?: ExecutionSource;
  destinations?: ExecutionDestination[];
  postOnly?: boolean;
  reduceOnly?: boolean;
  timeInForce?: "gtc" | "ioc" | "fok";
  triggerBy?: TriggerSource;
  tpTriggerBy?: TriggerSource;
  slTriggerBy?: TriggerSource;
  tpslMode?: "full" | "partial";
  positionIdx?: number;
  slippageTolerancePercent?: number;
  strategyParameters?: VenueStrategyParameters;
  trailingStopEnabled?: boolean;
  trailingTrailBy?: number;
  trailingMode?: "percentage" | "usd" | "ticks" | "atr";
  trailingActivation?: "immediate" | "custom-price" | "offset";
  trailingActivationPrice?: number;
  internalOrderId?: string;
  clientOrderId?: string;
  mainnetConfirmed?: boolean;
  liveConfirmation?: string;
};

export type HyperliquidRelayConnectionDraft = {
  masterWalletAddress: string;
  agentPrivateKey: string;
  network: "testnet" | "mainnet";
  accountName?: string;
  mainnetConfirmed?: boolean;
};

export type HyperliquidSyncPayload = {
  accountId: string;
  exchange: "hyperliquid";
  network: "testnet" | "mainnet";
  balances: unknown[];
  positions: unknown[];
  openOrders: OrderUpdate[];
  orderSync: NonNullable<PortfolioSnapshot["orderSync"]>[string];
  fills: unknown[];
  externalStateChanged: boolean;
  syncedAt: string;
};

export type ExchangeDiagnosticsPayload = {
  venueId: string;
  provider: string;
  network: string;
  executionMode: string;
  readiness: string;
  latencyMs: number;
  authentication: string;
  synchronization: string;
  publicStream: string;
  privateStream: string;
  permissions: {
    read: boolean;
    trading: boolean;
    withdrawal: boolean;
    warnings: string[];
  };
  time?: {
    serverTime?: string;
    clockSkewMs?: number;
  };
  metadata?: unknown[];
  balances?: unknown[];
  accountMetrics?: BybitAccountMetrics;
  positions?: unknown[];
  openOrders?: unknown[];
};

export type BybitAccountMetrics = {
  accountType: string;
  walletBalanceUsd: number;
  equityUsd: number;
  marginBalanceUsd: number;
  availableBalanceUsd: number;
  initialMarginUsd: number;
  maintenanceMarginUsd: number;
  unrealizedPnlUsd: number;
  accountImRate: number | null;
  accountMmRate: number | null;
  updatedAt: number;
};

export type ExchangeAccountSyncPayload = {
  accountId: string;
  exchange: "bybit";
  network: "mainnet";
  balances: Array<{ asset: string; free: number; locked: number; total: number; usdValue: number }>;
  positions: Array<{
    symbol: string;
    direction: "long" | "short" | "flat";
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
    margin: number;
    leverage: number;
    liquidationPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    positionIdx: number;
    positionMode: "one-way" | "hedge";
    marginMode: "cross" | "isolated";
    riskId: number;
    positionValue: number;
    openedAt: number;
  }>;
  openOrders: unknown[];
  strategies: Array<{
    strategyId: string;
    strategyType: "chaseOrder" | "twap" | "iceberg" | "pov";
    symbol: string;
    side: "buy" | "sell";
    status: string;
    quantity: number;
    filledQuantity: number;
    averageFillPrice: number | null;
    reduceOnly: boolean;
    duration: number;
    interval: number;
    reason?: string;
    createdAt: number;
    updatedAt: number;
  }>;
  accountMetrics: BybitAccountMetrics;
  executionState: {
    tradingEnabled: boolean;
    readOnly: boolean;
    allowedSymbols: string[];
    maxNotionalUsd: number;
    readinessReason: string;
  };
  instrumentRules: {
    nativeSymbol: string;
    canonicalBase: string;
    canonicalQuote: string;
    settlementAsset: string;
    tickSize: number;
    quantityStep: number;
    minQuantity: number;
    minNotional: number;
    maxQuantity: number;
    pricePrecision: number;
    quantityPrecision: number;
    leverageLimits: { min: number; max: number; step: number };
    supportedMarginModes: string[];
    supportedTimeInForce: string[];
    tradingStatus: string;
  } | null;
  selectedPosition: ExchangeAccountSyncPayload["positions"][number] | null;
  accountState: {
    unifiedMarginStatus: number;
    accountGeneration: string;
    marginMode: MarginMode;
    rawMarginMode: string;
    updatedAt: number;
  };
  riskLimits: Array<{
    id: number;
    symbol: string;
    riskLimitValue: number;
    maintenanceMargin: number;
    initialMargin: number;
    maxLeverage: number;
    lowestRisk: boolean;
  }>;
  priceLimit: {
    symbol: string;
    maximumBuyPrice: number;
    minimumSellPrice: number;
    updatedAt: number;
  };
  externalStateChanged: boolean;
  syncedAt: string;
  latencyMs: number;
};

export type BybitRuntimeStatusPayload = {
  venueId: "bybit";
  network: "mainnet";
  account: {
    found: boolean;
    id: string;
    label: string;
    maskedIdentifier: string;
    status: string;
    accountMode: string;
    permissions: string[];
    tradingEnabled: boolean;
    readOnly: boolean;
  };
  runtime: {
    credentialsDecryptable: boolean;
    serverTimeReachable: boolean;
    clockSkewMs: number | null;
    metadataLoaded: boolean;
    publicApiReachable: boolean;
    privateStreamRunning: boolean;
    privateStreamAuthenticated: boolean;
    lastPrivateEventAt: number | string | null;
    privateStreamAgeMs: number | null;
    balanceSyncHealthy: boolean;
    positionSyncHealthy: boolean;
    orderSyncHealthy: boolean;
    executionEndpointAvailable: boolean;
    reconnectCount: number;
    lastError: string | null;
  };
  safety: {
    validationModeEnabled: boolean;
    accountAllowlisted: boolean;
    symbolAllowlisted: boolean;
    maxNotionalConfigured: boolean;
    maxNotionalUsd: number;
    capacityMode: "operator-cap" | "account-margin";
    withdrawalPermissionAbsent: boolean;
    readPermissionPresent: boolean;
    tradePermissionPresent: boolean;
  };
  readiness: {
    executionReady: boolean;
    readinessReason: string;
    blockers: string[];
  };
  certification: {
    latestStatus: string;
    latestReadiness: string;
    mainnetValidated: boolean;
    decision: string;
    missingMandatory: string[];
    failed: string[];
    evidenceRows: number;
  };
};

export async function getPortfolioApiToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function fetchPortfolioSnapshotFromApi(activeAccountIds?: string[]): Promise<PortfolioSnapshot | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;
  if (activeAccountIds?.length === 0) return null;

  const query = activeAccountIds ? `?accountIds=${encodeURIComponent([...new Set(activeAccountIds)].join(","))}` : "";

  const response = await fetch(`/api/portfolio/snapshot${query}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  recordResponseTiming("portfolio.snapshot", response);

  if (!response.ok) throw new Error(await readApiError(response));
  return mapSnapshot(await response.json());
}

export async function connectExchangeAccountViaApi(draft: ExchangeConnectionDraft): Promise<PortfolioAccount | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapAccount(data.account);
}

export async function disconnectExchangeAccountViaApi(accountId: string): Promise<void> {
  const token = await getPortfolioApiToken();
  if (!token) return;
  const response = await fetch(`/api/exchange-accounts/${encodeURIComponent(accountId)}?accountId=${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function connectHyperliquidRelayViaApi(draft: HyperliquidRelayConnectionDraft): Promise<ConnectionRecord | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/protocols/hyperliquid/connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.connection as ConnectionRecord;
}

export async function submitPortfolioOrderViaApi(draft: PortfolioOrderDraft): Promise<OrderUpdate | null> {
  if (draft.exchange === "hyperliquid") return submitHyperliquidOrderViaApi(draft);

  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/execution/order", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });
  recordResponseTiming("execution.server_route", response);

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.order);
}

export async function updateBybitAccountModeViaApi(draft: {
  accountId: string;
  action: "set-leverage" | "switch-margin-mode" | "switch-position-mode";
  symbol: string;
  category?: "linear" | "inverse";
  leverage?: number;
  marginMode?: MarginMode;
  positionMode?: "one-way" | "hedge";
  mainnetConfirmed: boolean;
  liveConfirmation: string;
}): Promise<{ report: Record<string, unknown> } | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/execution/account-mode", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function stopBybitStrategyViaApi(draft: {
  accountId: string;
  strategyId: string;
  symbol: string;
  mainnetConfirmed: boolean;
  liveConfirmation: string;
}) {
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/execution/strategy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()).report as { strategyId: string; status: string };
}

export async function runExchangeAccountDiagnosticsViaApi(accountId: string, symbol = "BTCUSDT"): Promise<ExchangeDiagnosticsPayload | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/diagnostics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accountId, symbol })
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.diagnostics as ExchangeDiagnosticsPayload;
}

export async function syncExchangeAccountViaApi(accountId: string, symbol = "BTCUSDT", marketKind: MarketKind = "perpetual"): Promise<ExchangeAccountSyncPayload | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accountId, symbol, marketKind })
  });
  recordResponseTiming("account.sync_route", response);

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.sync as ExchangeAccountSyncPayload;
}

export async function cancelVenueOrderViaApi(order: OrderUpdate): Promise<OrderUpdate | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/execution/cancel", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: order.internalId || order.orderId,
      venueOrderId: order.venueOrderId || order.orderId,
      accountId: order.accountId,
      symbol: order.symbol,
      category: order.category,
      marketKind: order.category === "spot" ? "spot" : "perpetual",
      clientOrderId: order.clientOrderId,
      mainnetConfirmed: true,
      liveConfirmation: "LIVE"
    })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.order);
}

export async function modifyVenueOrderViaApi(order: OrderUpdate, changes: { quantity?: number; limitPrice?: number }): Promise<OrderUpdate | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/execution/modify", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      localOrderId: order.externallyCreated ? undefined : order.internalId,
      orderId: order.venueOrderId || order.orderId,
      exchangeOrderId: order.venueOrderId || order.orderId,
      accountId: order.accountId,
      symbol: order.symbol,
      category: order.category,
      marketKind: order.category === "spot" ? "spot" : "perpetual",
      clientOrderId: order.clientOrderId,
      quantity: changes.quantity,
      limitPrice: changes.limitPrice,
      mainnetConfirmed: true,
      liveConfirmation: "LIVE"
    })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.report);
}

export async function setBybitTradingEnabledViaApi(accountId: string, enabled: boolean, confirmation: string): Promise<{ status: "enabled" | "disabled"; accountId: string } | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/mainnet-validation", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      accountId,
      action: enabled ? "enable" : "disable",
      confirmation
    })
  });

  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function getBybitRuntimeStatusViaApi(accountId: string, symbol = "BTCUSDT"): Promise<BybitRuntimeStatusPayload | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const params = new URLSearchParams({ accountId, symbol });
  const response = await fetch(`/api/exchange-accounts/bybit-runtime-status?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) throw new Error(await readApiError(response));
  return await response.json() as BybitRuntimeStatusPayload;
}

export async function submitHyperliquidOrderViaApi(draft: PortfolioOrderDraft): Promise<OrderUpdate | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/protocols/hyperliquid/order", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.report || data.order);
}

export async function cancelHyperliquidOrderViaApi(draft: {
  accountId: string;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
  mainnetConfirmed?: boolean;
}): Promise<OrderUpdate | null> {
  return submitHyperliquidActionViaApi("/api/protocols/hyperliquid/cancel", draft);
}

export async function modifyHyperliquidOrderViaApi(draft: PortfolioOrderDraft & { orderId?: string }): Promise<OrderUpdate | null> {
  return submitHyperliquidActionViaApi("/api/protocols/hyperliquid/modify", draft);
}

export async function closeHyperliquidPositionViaApi(draft: {
  accountId: string;
  symbol: string;
  quantity?: number;
  referencePrice?: number;
  mainnetConfirmed?: boolean;
}): Promise<OrderUpdate | null> {
  return submitHyperliquidActionViaApi("/api/protocols/hyperliquid/close-position", draft);
}

export async function syncHyperliquidAccountViaApi(accountId: string): Promise<HyperliquidSyncPayload | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/protocols/hyperliquid/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accountId })
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.sync as HyperliquidSyncPayload;
}

async function submitHyperliquidActionViaApi(path: string, draft: Record<string, unknown>): Promise<OrderUpdate | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.report);
}

async function readApiError(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || `HTTP ${response.status}`;

  try {
    const data = JSON.parse(text);
    return data.error || data.message || response.statusText || `HTTP ${response.status}`;
  } catch {
    const diagnostic = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
    return diagnostic || response.statusText || `HTTP ${response.status}`;
  }
}

function mapSnapshot(data: ApiSnapshot): PortfolioSnapshot {
  const accountById = new Map(data.accounts.map((account) => [account.id, account]));

  return {
    summary: data.summary,
    accounts: data.accounts.map(mapAccount),
    balances: data.balances.map((balance) => ({
      accountId: balance.accountId,
      exchange: accountById.get(balance.accountId)?.exchange ?? "mock",
      asset: balance.asset,
      free: balance.free,
      locked: balance.locked,
      total: balance.total,
      usdValue: balance.usdValue ?? undefined
    })),
    positions: data.positions.map((position) => ({
      ...position,
      openedAt: toMillis(position.openedAt)
    })),
    orders: data.orders.map(mapOrder),
    orderSync: data.orderSync,
    curves: buildCurves(data.summary)
  };
}

function mapAccount(account: ApiAccount): PortfolioAccount {
  return {
    id: account.id,
    exchange: account.exchange,
    label: account.accountName,
    accountName: account.accountName,
    permissions: account.permissions || ["read-account", "read-orders", "read-positions"],
    isPaper: false,
    connectedAt: toMillis(account.createdAt),
    lastValidatedAt: toMillis(account.updatedAt),
    status: account.status,
    apiHealth: account.apiHealth === "unknown" ? "warning" : account.apiHealth,
    latencyMs: account.latencyMs || 0,
    balanceUsd: 0,
    equityUsd: 0,
    marginUsed: 0,
    availableMargin: 0,
    buyingPower: 0,
    leverage: 1,
    dailyPnl: 0,
    monthlyPnl: 0,
    openPositions: 0,
    openOrders: 0,
    riskControls: account.riskControls || defaultRiskControls
  };
}

function mapOrder(order: any): OrderUpdate {
  const createdTime = toMillis(order.created_at || order.createdTime || order.time);
  const filledQuantity = Number(order.filled_quantity ?? order.filledQuantity ?? order.cumulativeFilledQuantity ?? 0);
  const quantity = Number(order.quantity ?? 0);
  const remainingQuantity = Number(order.remainingQuantity ?? order.leavesQuantity ?? Math.max(0, quantity - filledQuantity));
  return {
    accountId: order.account_id || order.accountId,
    exchange: order.exchange,
    orderId: order.venueOrderId || order.exchange_order_id || order.orderId || order.id,
    venueOrderId: order.venueOrderId || order.exchange_order_id || order.orderId,
    clientOrderId: order.client_order_id || order.clientOrderId,
    symbol: order.symbol,
    status: order.status,
    filledQuantity,
    averageFillPrice: order.average_fill_price === null || order.average_fill_price === undefined
      ? undefined
      : Number(order.average_fill_price),
    reason: order.rejection_reason || order.reason,
    time: createdTime,
    internalId: order.internalId || order.id,
    connectionId: order.connectionId || order.account_id || order.accountId,
    network: order.network || "mainnet",
    category: order.category,
    normalizedSymbol: order.normalizedSymbol || normalizeOrderSymbol(order.symbol),
    side: order.side,
    type: order.type || order.order_type || order.orderType,
    orderType: order.orderType || order.order_type || order.type,
    price: nullableOrderNumber(order.price ?? order.limit_price),
    triggerPrice: nullableOrderNumber(order.triggerPrice ?? order.stop_price),
    quantity,
    leavesQuantity: remainingQuantity,
    remainingQuantity,
    timeInForce: String(order.timeInForce || order.time_in_force || "").toLowerCase(),
    reduceOnly: Boolean(order.reduceOnly ?? order.reduce_only),
    closeOnTrigger: Boolean(order.closeOnTrigger),
    positionIdx: Number(order.positionIdx || 0),
    source: order.source === "venue" ? "venue" : "black-terminal",
    ownership: order.ownership || (order.externallyCreated ? "external" : "black-terminal"),
    externallyCreated: Boolean(order.externallyCreated),
    createdTime,
    updatedTime: toMillis(order.updated_at || order.updatedTime || createdTime),
    venuePriceString: order.venuePriceString === undefined ? undefined : String(order.venuePriceString),
    venueUpdatedTime: toMillis(order.venueUpdatedTime || order.updated_at || order.updatedTime || createdTime),
    canonicalKey: order.canonicalKey,
    lastSource: order.lastSource || order.source,
    venueAccountId: order.venueAccountId
  };
}

function normalizeOrderSymbol(symbol: unknown) {
  return String(symbol || "").replace(/[^a-zA-Z0-9]/g, "").replace(/PERP(ETUAL)?$/i, "").toUpperCase();
}

function nullableOrderNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildCurves(summary: PortfolioSnapshot["summary"]) {
  const base = summary.totalEquity || 0;
  if (base <= 0) {
    return {
      equity: [],
      drawdown: [],
      dailyReturns: [],
      exposure: []
    };
  }

  return {
    equity: [0.97, 0.985, 0.978, 0.995, 0.99, 1].map((multiplier, index) => ({
      time: `D-${5 - index}`,
      value: base * multiplier
    })),
    drawdown: [0, 0.7, 1.2, 0.8, 1.6, summary.drawdownPct || 0].map((value, index) => ({
      time: `D-${5 - index}`,
      value
    })),
    dailyReturns: [0, 0, 0, 0, 0, summary.dailyPnl || 0].map((value, index) => ({
      time: `D-${5 - index}`,
      value
    })),
    exposure: [
      { label: "Margin", value: summary.totalEquity > 0 ? Math.round((summary.marginUsed / summary.totalEquity) * 100) : 0 },
      { label: "Cash", value: summary.totalEquity > 0 ? Math.round((summary.availableMargin / summary.totalEquity) * 100) : 0 }
    ].filter((item) => item.value > 0)
  };
}

function toMillis(value?: string | number | null) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

function recordResponseTiming(name: string, response: Response) {
  const routeMs = Number(response.headers.get("x-black-terminal-route-ms"));
  if (Number.isFinite(routeMs)) blackCorePerformanceMonitor.recordMetric(`${name}_ms`, routeMs, "ms");
}
