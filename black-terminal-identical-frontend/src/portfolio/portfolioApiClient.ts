import { supabase } from "../lib/supabase";
import type { OrderUpdate } from "../execution/types";
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
  orderType: string;
  quantity: number;
  quantityMode?: string;
  referencePrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  postOnly?: boolean;
  reduceOnly?: boolean;
  timeInForce?: "gtc" | "ioc" | "fok";
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

export async function submitPortfolioOrderViaApi(draft: PortfolioOrderDraft): Promise<OrderUpdate | null> {
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
