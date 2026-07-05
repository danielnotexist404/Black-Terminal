import type { OrderRequest, OrderUpdate } from "../execution/types";
import type { Balance } from "../execution/types";
import type { ExchangeId } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";

export type ConnectionCategory = "centralized-exchange" | "wallet" | "market-data" | "institutional";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"
  | "offline"
  | "disconnected"
  | "auth-failed"
  | "unsupported";

export type ConnectionCapability =
  | "market-orders"
  | "spot-orders"
  | "limit-orders"
  | "conditional-orders"
  | "swap"
  | "perpetual-orders"
  | "modify-orders"
  | "cancel-orders"
  | "leverage"
  | "cross-margin"
  | "isolated-margin"
  | "private-websocket"
  | "public-websocket"
  | "wallet-connect"
  | "transaction-signing"
  | "token-transfers"
  | "network-switching"
  | "balances"
  | "positions"
  | "orders"
  | "trades"
  | "twap"
  | "iceberg";

export type ApiPermissionReport = {
  read: boolean;
  trading: boolean;
  withdrawal: boolean;
  warnings: string[];
};

export type ConnectionHealth = {
  status: ConnectionStatus;
  latencyMs: number;
  heartbeat: "ok" | "failed" | "unknown";
  authentication: "authenticated" | "failed" | "not-required" | "unknown";
  synchronization: "synced" | "syncing" | "stale" | "unknown";
  privateStream: "connected" | "disconnected" | "not-supported" | "unknown";
  publicStream: "connected" | "disconnected" | "not-supported" | "unknown";
  subscriptionCount: number;
  reconnectCount: number;
  lastError?: string;
  lastSuccessfulHeartbeat?: number;
  permissions: ApiPermissionReport;
  rateLimitUsage?: string;
};

export type ConnectionRecord = {
  id: string;
  adapterId: string;
  category: ConnectionCategory;
  provider: string;
  label: string;
  status: ConnectionStatus;
  capabilities: ConnectionCapability[];
  health: ConnectionHealth;
  accountId?: string;
  walletAddress?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type ConnectRequest = {
  adapterId: string;
  category: ConnectionCategory;
  provider: string;
  label: string;
  credentials?: unknown;
  metadata?: Record<string, unknown>;
};

export type ConnectionSubscription = {
  id: string;
  channel: string;
  params?: Record<string, unknown>;
};

export type ConnectionDiagnostics = ConnectionRecord & {
  uptimeMs: number;
};

export interface ConnectionAdapter {
  id: string;
  label: string;
  category: ConnectionCategory;
  capabilities: ConnectionCapability[];
  connect(request: ConnectRequest): Promise<ConnectionRecord>;
  disconnect(connection: ConnectionRecord): Promise<void>;
  authenticate?(connection: ConnectionRecord): Promise<ConnectionHealth>;
  heartbeat(connection: ConnectionRecord): Promise<ConnectionHealth>;
  reconnect?(connection: ConnectionRecord): Promise<ConnectionRecord>;
  sync?(connection: ConnectionRecord): Promise<Partial<ConnectionRecord>>;
  subscribe?(connection: ConnectionRecord, subscription: ConnectionSubscription): Promise<void>;
  unsubscribe?(connection: ConnectionRecord, subscriptionId: string): Promise<void>;
  execute?(connection: ConnectionRecord, order: OrderRequest): Promise<OrderUpdate>;
  cancelOrder?(connection: ConnectionRecord, orderId: string): Promise<OrderUpdate>;
  modifyOrder?(connection: ConnectionRecord, orderId: string, patch: Partial<OrderRequest>): Promise<OrderUpdate>;
  retrieveBalances?(connection: ConnectionRecord): Promise<Balance[]>;
  retrievePositions?(connection: ConnectionRecord): Promise<PortfolioPosition[]>;
  retrieveOrders?(connection: ConnectionRecord): Promise<OrderUpdate[]>;
  retrieveTrades?(connection: ConnectionRecord): Promise<unknown[]>;
  retrieveAccountInformation?(connection: ConnectionRecord): Promise<unknown>;
  getDiagnostics?(connection: ConnectionRecord): Promise<Partial<ConnectionHealth>>;
}

export function defaultPermissionReport(patch: Partial<ApiPermissionReport> = {}): ApiPermissionReport {
  return {
    read: false,
    trading: false,
    withdrawal: false,
    warnings: [],
    ...patch
  };
}

export function defaultConnectionHealth(patch: Partial<ConnectionHealth> = {}): ConnectionHealth {
  return {
    status: "offline",
    latencyMs: 0,
    heartbeat: "unknown",
    authentication: "unknown",
    synchronization: "unknown",
    privateStream: "unknown",
    publicStream: "unknown",
    subscriptionCount: 0,
    reconnectCount: 0,
    permissions: defaultPermissionReport(),
    ...patch
  };
}

export function isExchangeProvider(provider: string): provider is ExchangeId {
  return Boolean(provider);
}
