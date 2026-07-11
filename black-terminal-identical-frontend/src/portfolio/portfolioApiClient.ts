import { supabase } from "../lib/supabase";
import type { ConnectionRecord } from "../connectivity/types";
import type { ExecutionDestination, ExecutionSource, MarginMode, OrderType, OrderUpdate, SizingMethod } from "../execution/types";
import type { ExchangeId, MarketKind } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";
import { defaultRiskControls } from "../risk/types";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "./types";

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
  openOrders: unknown[];
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
  positions?: unknown[];
  openOrders?: unknown[];
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

export async function fetchPortfolioSnapshotFromApi(): Promise<PortfolioSnapshot | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/portfolio/snapshot", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

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

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.order);
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

export async function syncExchangeAccountViaApi(accountId: string, symbol = "BTCUSDT"): Promise<unknown | null> {
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accountId, symbol })
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.sync;
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
  try {
    const data = await response.json();
    return data.error || response.statusText;
  } catch {
    return response.statusText;
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
  return {
    accountId: order.account_id || order.accountId,
    exchange: order.exchange,
    orderId: order.id || order.orderId,
    clientOrderId: order.client_order_id || order.clientOrderId,
    symbol: order.symbol,
    status: order.status,
    filledQuantity: Number(order.filled_quantity ?? order.filledQuantity ?? 0),
    averageFillPrice: order.average_fill_price === null || order.average_fill_price === undefined
      ? undefined
      : Number(order.average_fill_price),
    reason: order.rejection_reason || order.reason,
    time: toMillis(order.created_at || order.time)
  };
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
