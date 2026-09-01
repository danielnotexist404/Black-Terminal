import { createId } from "../ids";
import { TauriSecureCredentialStore } from "../secureCredentialStore";
import type { Balance, OrderStatus, OrderUpdate, TradingPermission } from "../../execution/types";
import type { PortfolioPosition } from "../../positions/types";
import { defaultRiskControls } from "../../risk/types";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "../../portfolio/types";
import type { StrategyWorkspace } from "../../modules/strategy-lab/automation/strategyAutomation.types";
import { PORTFOLIO_STALE_AFTER_MS } from "../../portfolio/portfolioFreshness";
import { deleteLocalDocument, listLocalDocuments, putLocalDocument } from "./localDocumentStore";
import { syncLocalBybitAccount, type LocalBybitAccountSnapshot, type LocalBybitEnvironment } from "./localBybitClient";

const BROKER_NAMESPACE = "broker-accounts";
const LOCAL_BROKER_REFRESH_MS = 10_000;
const credentialStore = new TauriSecureCredentialStore();

export type LocalBrokerAccountRecord = {
  schemaVersion: 1;
  account: PortfolioAccount;
  environment: LocalBybitEnvironment;
  mainnetConfirmed: boolean;
  workspaceScope?: "PERSONAL" | "STRATEGY_LAB";
  lastSnapshot: LocalBybitAccountSnapshot | null;
  lastError: string | null;
  updatedAt: number;
};

const records = new Map<string, LocalBrokerAccountRecord>();
const refreshInFlight = new Map<string, Promise<LocalBrokerAccountRecord>>();

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(object) : [];
}

export function toLocalBybitEnvironment(value: ExchangeConnectionDraft["environment"]): LocalBybitEnvironment {
  if (value === "mainnet") return "MAINNET";
  if (value === "testnet") return "TESTNET";
  return "DEMO";
}

function snapshotCounts(snapshot: LocalBybitAccountSnapshot) {
  const positions = list(object(snapshot.positions).list).filter((position) => number(position.size) > 0);
  const openOrders = list(object(snapshot.openOrders).list).filter((order) => !["Filled", "Cancelled", "Rejected", "Deactivated"].includes(String(order.orderStatus || "")));
  return { positions: positions.length, orders: openOrders.length };
}

function permissions(snapshot: LocalBybitAccountSnapshot): TradingPermission[] {
  const result: TradingPermission[] = ["read-account", "read-orders", "read-positions"];
  if (snapshot.tradingEnabled) result.push("place-orders", "cancel-orders", "modify-orders");
  if (!snapshot.withdrawalEnabled) result.push("withdraw-disabled");
  return result;
}

function accountFromSnapshot(
  accountId: string,
  accountName: string,
  snapshot: LocalBybitAccountSnapshot,
  connectedAt: number,
): PortfolioAccount {
  const equity = number(snapshot.totalEquityUsd);
  const balance = number(snapshot.totalWalletBalanceUsd);
  const available = number(snapshot.totalAvailableBalanceUsd);
  const margin = number(snapshot.totalInitialMarginUsd);
  const counts = snapshotCounts(snapshot);
  return {
    id: accountId,
    exchange: "bybit",
    label: accountName,
    accountName,
    permissions: permissions(snapshot),
    isPaper: snapshot.environment !== "MAINNET",
    connectedAt,
    lastValidatedAt: snapshot.capturedAt,
    status: snapshot.tradingEnabled ? "connected" : "read-only",
    apiHealth: "healthy",
    latencyMs: snapshot.latencyMs,
    balanceUsd: balance,
    equityUsd: equity,
    marginUsed: margin,
    availableMargin: available,
    buyingPower: available,
    leverage: equity > 0 ? Math.max(1, (equity + margin) / equity) : 1,
    dailyPnl: number(snapshot.totalPerpetualUnrealizedPnlUsd),
    monthlyPnl: 0,
    openPositions: counts.positions,
    openOrders: counts.orders,
    network: snapshot.environment.toLowerCase() as "mainnet" | "demo" | "testnet",
    executionEnvironment: snapshot.environment === "MAINNET" ? "MAINNET_LIVE" : snapshot.environment,
    riskControls: {
      ...defaultRiskControls,
      maxPositionUsd: Math.max(equity, defaultRiskControls.maxPositionUsd),
      maxPortfolioExposureUsd: Math.max(equity, defaultRiskControls.maxPortfolioExposureUsd),
      allowedSymbols: ["*"],
      readOnlyMode: !snapshot.tradingEnabled,
      tradingEnabled: snapshot.tradingEnabled,
    },
  };
}

async function persist(record: LocalBrokerAccountRecord) {
  const saved = await putLocalDocument(BROKER_NAMESPACE, record.account.id, record);
  if (!saved) throw new Error("The native broker-account store is unavailable.");
  records.set(record.account.id, record);
  return record;
}

export async function connectLocalBybitAccount(draft: ExchangeConnectionDraft) {
  if (draft.exchange !== "bybit") throw new Error("The standalone runtime currently supports authenticated local execution only on Bybit.");
  const accountId = createId("local-bybit");
  const environment = toLocalBybitEnvironment(draft.environment);
  const accountName = draft.accountName.trim() || `Bybit ${environment}`;
  await credentialStore.storeExchangeCredentials({
    accountId,
    exchange: "bybit",
    apiKey: draft.apiKey,
    apiSecret: draft.apiSecret,
  });
  try {
    const snapshot = await syncLocalBybitAccount(accountId, environment);
    const record: LocalBrokerAccountRecord = {
      schemaVersion: 1,
      account: accountFromSnapshot(accountId, accountName, snapshot, Date.now()),
      environment,
      mainnetConfirmed: draft.mainnetConfirmed === true,
      workspaceScope: draft.workspaceScope || "PERSONAL",
      lastSnapshot: snapshot,
      lastError: null,
      updatedAt: Date.now(),
    };
    await persist(record);
    return record.account;
  } catch (error) {
    await credentialStore.deleteExchangeCredentials(accountId).catch(() => undefined);
    throw error;
  }
}

export async function restoreLocalBrokerAccounts() {
  const documents = await listLocalDocuments<LocalBrokerAccountRecord>(BROKER_NAMESPACE);
  records.clear();
  for (const document of documents) {
    const record = document.value;
    if (record?.schemaVersion === 1 && record.account?.id === document.key) records.set(document.key, record);
  }
  await Promise.allSettled([...records.keys()].map((accountId) => refreshLocalBrokerAccount(accountId, true)));
  return [...records.values()].filter((record) => (record.workspaceScope || "PERSONAL") === "PERSONAL").map((record) => record.account);
}

export function listLocalBrokerAccounts(workspaceScope?: "PERSONAL" | "STRATEGY_LAB") {
  return [...records.values()]
    .filter((record) => !workspaceScope || (record.workspaceScope || "PERSONAL") === workspaceScope)
    .map((record) => record.account);
}

export function getLocalBrokerRecord(accountId: string) {
  return records.get(accountId) ?? null;
}

export function getLocalBrokerSymbolExposure(accountId: string, symbol: string) {
  const record = records.get(accountId);
  const normalizedSymbol = symbol.trim().toUpperCase();
  const snapshot = record?.lastSnapshot;
  if (!snapshot) return { positions: 0, openOrders: 0 };
  const positions = list(object(snapshot.positions).list)
    .filter((position) => String(position.symbol || "").toUpperCase() === normalizedSymbol && number(position.size) > 0)
    .length;
  const openOrders = list(object(snapshot.openOrders).list)
    .filter((order) => String(order.symbol || "").toUpperCase() === normalizedSymbol)
    .filter((order) => !["Filled", "Cancelled", "Rejected", "Deactivated"].includes(String(order.orderStatus || "")))
    .length;
  return { positions, openOrders };
}

export async function setLocalBrokerMainnetConfirmation(accountId: string, enabled: boolean) {
  const current = records.get(accountId);
  if (!current) throw new Error("The local broker account is not registered.");
  if (current.environment !== "MAINNET") return current;
  return persist({
    ...current,
    mainnetConfirmed: enabled,
    updatedAt: Date.now(),
  });
}

export async function refreshLocalBrokerAccount(accountId: string, force = false): Promise<LocalBrokerAccountRecord> {
  const current = records.get(accountId);
  if (!current) throw new Error("The local broker account is not registered.");
  if (!force && current.lastSnapshot && Date.now() - current.lastSnapshot.capturedAt < LOCAL_BROKER_REFRESH_MS) return current;
  const active = refreshInFlight.get(accountId);
  if (active) return active;
  const request = (async () => {
    try {
      const snapshot = await syncLocalBybitAccount(accountId, current.environment);
      return await persist({
        ...current,
        account: accountFromSnapshot(accountId, current.account.accountName, snapshot, current.account.connectedAt),
        lastSnapshot: snapshot,
        lastError: null,
        updatedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: LocalBrokerAccountRecord = {
        ...current,
        account: { ...current.account, status: "degraded", apiHealth: "failed" },
        lastError: message,
        updatedAt: Date.now(),
      };
      await persist(failed).catch(() => records.set(accountId, failed));
      throw error;
    }
  })().finally(() => refreshInFlight.delete(accountId));
  refreshInFlight.set(accountId, request);
  return request;
}

export async function disconnectLocalBrokerAccount(accountId: string) {
  const strategies = await listLocalDocuments<StrategyWorkspace>("strategies");
  const activeReferences = strategies.flatMap((document) => document.value.bindings || [])
    .filter((binding) => binding.accountId === accountId && binding.status !== "DISCONNECTED");
  if (activeReferences.length > 0) {
    throw new Error("Pause and disconnect every Strategy Lab target using this broker account before deleting its credentials.");
  }
  const mandates = await listLocalDocuments<{ accountId?: string; status?: string }>("investment-group-mandates");
  const activeMandates = mandates.filter((document) => document.value.accountId === accountId && document.value.status !== "REVOKED");
  if (activeMandates.length > 0) {
    throw new Error("Pause or revoke every Investment Group execution mandate using this broker account before deleting its credentials.");
  }
  await credentialStore.deleteExchangeCredentials(accountId);
  await deleteLocalDocument(BROKER_NAMESPACE, accountId);
  records.delete(accountId);
}

function mapPositions(record: LocalBrokerAccountRecord): PortfolioPosition[] {
  const snapshot = record.lastSnapshot;
  if (!snapshot) return [];
  return list(object(snapshot.positions).list)
    .filter((position) => number(position.size) > 0 && ["Buy", "Sell"].includes(String(position.side)))
    .map((position) => ({
      id: `bybit:${record.account.id}:${String(position.symbol)}:${number(position.positionIdx)}`,
      accountId: record.account.id,
      exchange: "bybit" as const,
      symbol: String(position.symbol || ""),
      network: record.environment.toLowerCase(),
      category: "linear",
      marketKind: "perpetual",
      positionIdx: number(position.positionIdx),
      updatedAt: number(position.updatedTime) || snapshot.capturedAt,
      snapshotStatus: "live" as const,
      direction: String(position.side) === "Buy" ? "long" as const : "short" as const,
      quantity: number(position.size),
      averagePrice: number(position.avgPrice),
      currentPrice: number(position.markPrice),
      unrealizedPnl: number(position.unrealisedPnl),
      realizedPnl: number(position.cumRealisedPnl),
      margin: number(position.positionIM),
      leverage: number(position.leverage),
      liquidationPrice: number(position.liqPrice) || undefined,
      stopLoss: number(position.stopLoss) || undefined,
      takeProfit: number(position.takeProfit) || undefined,
      openedAt: number(position.createdTime) || snapshot.capturedAt,
    }));
}

function mapBalances(record: LocalBrokerAccountRecord): Balance[] {
  const snapshot = record.lastSnapshot;
  if (!snapshot) return [];
  const unified = list(object(snapshot.wallet).list)[0] ?? {};
  return list(unified.coin).map((coin) => ({
    accountId: record.account.id,
    exchange: "bybit" as const,
    asset: String(coin.coin || ""),
    free: number(coin.availableToWithdraw || coin.walletBalance) - number(coin.locked),
    locked: number(coin.locked),
    total: number(coin.walletBalance),
    usdValue: number(coin.usdValue),
  }));
}

function mapOrderStatus(status: string): OrderStatus {
  const key = status.toLowerCase();
  if (key === "filled") return "filled";
  if (key === "partiallyfilled") return "partially-filled";
  if (key === "cancelled" || key === "deactivated") return "cancelled";
  if (key === "rejected") return "rejected";
  return key === "new" || key === "untriggered" || key === "triggered" ? "working" : "pending";
}

function mapOrders(record: LocalBrokerAccountRecord): OrderUpdate[] {
  const snapshot = record.lastSnapshot;
  if (!snapshot) return [];
  return list(object(snapshot.openOrders).list).map((order) => ({
    accountId: record.account.id,
    exchange: "bybit" as const,
    orderId: String(order.orderId || ""),
    venueOrderId: String(order.orderId || ""),
    clientOrderId: String(order.orderLinkId || "") || undefined,
    symbol: String(order.symbol || ""),
    status: mapOrderStatus(String(order.orderStatus || "")),
    filledQuantity: number(order.cumExecQty),
    averageFillPrice: number(order.avgPrice) || undefined,
    time: number(order.updatedTime) || snapshot.capturedAt,
    network: record.environment.toLowerCase(),
    category: "linear",
    side: String(order.side) === "Buy" ? "buy" as const : "sell" as const,
    orderType: String(order.orderType || ""),
    price: number(order.price) || undefined,
    triggerPrice: number(order.triggerPrice) || undefined,
    quantity: number(order.qty),
    leavesQuantity: number(order.leavesQty),
    reduceOnly: order.reduceOnly === true,
    closeOnTrigger: order.closeOnTrigger === true,
    positionIdx: number(order.positionIdx),
    source: "venue" as const,
    ownership: String(order.orderLinkId || "").startsWith("bt-") ? "black-terminal" as const : "external" as const,
  }));
}

export async function getLocalBrokerPortfolioSnapshot(activeAccountIds?: string[]): Promise<PortfolioSnapshot> {
  const accountIds = activeAccountIds ?? [...records.values()]
    .filter((record) => (record.workspaceScope || "PERSONAL") === "PERSONAL")
    .map((record) => record.account.id);
  await Promise.allSettled(accountIds.map((accountId) => refreshLocalBrokerAccount(accountId)));
  const selected = accountIds.map((accountId) => records.get(accountId)).filter((value): value is LocalBrokerAccountRecord => Boolean(value));
  const accounts = selected.map((record) => record.account);
  const positions = selected.flatMap(mapPositions);
  const balances = selected.flatMap(mapBalances);
  const orders = selected.flatMap(mapOrders);
  const now = Date.now();
  const syncedAt = selected.length ? Math.min(...selected.map((record) => record.lastSnapshot?.capturedAt ?? 0)) : 0;
  const failures = selected.filter((record) => record.lastError);
  const totalEquity = accounts.reduce((sum, account) => sum + account.equityUsd, 0);
  const totalBalance = accounts.reduce((sum, account) => sum + account.balanceUsd, 0);
  const marginUsed = accounts.reduce((sum, account) => sum + account.marginUsed, 0);
  const availableMargin = accounts.reduce((sum, account) => sum + account.availableMargin, 0);
  return {
    freshness: {
      status: failures.length ? "degraded" : accounts.length ? "live" : "disconnected",
      source: accounts.length ? "broker-rest" : "local-empty",
      fetchedAt: now,
      brokerSyncedAt: syncedAt || null,
      blockerCode: failures.length ? "BROKER_SYNC_FAILED" : null,
      ageMs: syncedAt ? Math.max(0, now - syncedAt) : 0,
      staleAfterMs: PORTFOLIO_STALE_AFTER_MS,
      quarantinedPositionCount: failures.length ? positions.length : 0,
      message: failures.length
        ? `${failures.length} local broker account(s) failed authoritative reconciliation.`
        : accounts.length ? "Authoritative local Bybit REST snapshot." : "No connected local broker account.",
    },
    summary: {
      totalEquity,
      totalBalance,
      unrealizedPnl: positions.reduce((sum, position) => sum + position.unrealizedPnl, 0),
      realizedPnl: positions.reduce((sum, position) => sum + position.realizedPnl, 0),
      dailyPnl: accounts.reduce((sum, account) => sum + account.dailyPnl, 0),
      weeklyPnl: 0,
      monthlyPnl: accounts.reduce((sum, account) => sum + account.monthlyPnl, 0),
      drawdownPct: 0,
      marginUsed,
      availableMargin,
      buyingPower: accounts.reduce((sum, account) => sum + account.buyingPower, 0),
      leverage: totalEquity > 0 ? marginUsed / totalEquity : 0,
      riskScore: failures.length ? 100 : 0,
    },
    accounts,
    balances,
    positions,
    orders,
    curves: { equity: [], drawdown: [], dailyReturns: [], exposure: [] },
    orderSync: {},
  };
}
