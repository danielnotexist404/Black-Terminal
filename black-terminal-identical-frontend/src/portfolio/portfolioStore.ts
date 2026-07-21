import { getBrokerAdapter } from "../broker/brokerRegistry";
import { getVenueCertification } from "../connectivity/venueRegistry";
import { createId } from "../core/ids";
import { TauriSecureCredentialStore } from "../core/secureCredentialStore";
import type { AccountConnection, OrderUpdate } from "../execution/types";
import { marketCatalog } from "../market-data/marketCatalog";
import type { PortfolioPosition } from "../positions/types";
import { defaultRiskControls } from "../risk/types";
import { connectExchangeAccountViaApi, fetchPortfolioSnapshotFromApi } from "./portfolioApiClient";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "./types";
import { blackCoreEventBus } from "../core/blackCore";
import { blackCorePerformanceMonitor } from "../performance/performanceMonitor";

const credentialStore = new TauriSecureCredentialStore();

let accounts: PortfolioAccount[] = [];
let orders: OrderUpdate[] = [];
let snapshotCache: { value: PortfolioSnapshot; loadedAt: number; scopeKey: string } | null = null;
let snapshotRequest: { value: Promise<PortfolioSnapshot>; scopeKey: string } | null = null;
const snapshotFreshMs = 2000;

function buildCurves() {
  return {
    equity: [],
    drawdown: [],
    dailyReturns: [],
    exposure: []
  };
}

export async function getPortfolioSnapshot(activeAccountIds?: string[]): Promise<PortfolioSnapshot> {
  const scopedAccountIds = activeAccountIds ? [...new Set(activeAccountIds.filter(Boolean))].sort() : undefined;
  const scopeKey = scopedAccountIds ? scopedAccountIds.join(",") : "all";
  if (scopedAccountIds?.length === 0) return emptyPortfolioSnapshot();
  if (snapshotCache?.scopeKey === scopeKey && Date.now() - snapshotCache.loadedAt < snapshotFreshMs) {
    blackCorePerformanceMonitor.recordMetric("account.freshness_ms", Date.now() - snapshotCache.loadedAt, "ms");
    return snapshotCache.value;
  }
  if (snapshotRequest?.scopeKey === scopeKey) return snapshotRequest.value;
  const finish = blackCorePerformanceMonitor.startSpan("account.snapshot_ms");
  const request = loadPortfolioSnapshot(scopedAccountIds)
    .then((value) => {
      snapshotCache = { value, loadedAt: Date.now(), scopeKey };
      return value;
    })
    .finally(() => {
      finish();
      if (snapshotRequest?.scopeKey === scopeKey) snapshotRequest = null;
    });
  snapshotRequest = { value: request, scopeKey };
  return request;
}

export function invalidatePortfolioSnapshot() {
  snapshotCache = null;
}

async function loadPortfolioSnapshot(activeAccountIds?: string[]): Promise<PortfolioSnapshot> {
  try {
    const remoteSnapshot = await fetchPortfolioSnapshotFromApi(activeAccountIds);
    if (remoteSnapshot) return remoteSnapshot;
  } catch (error) {
    console.error("Portfolio API snapshot failed, using local fallback.", error);
  }

  const scopedAccounts = activeAccountIds ? accounts.filter((account) => activeAccountIds.includes(account.id)) : accounts;
  const scopedAccountSet = new Set(scopedAccounts.map((account) => account.id));
  const positionsByAccount = await Promise.all(scopedAccounts.map((account) => getBrokerAdapter(account.exchange).getPositions(account.id)));
  const balancesByAccount = await Promise.all(scopedAccounts.map((account) => getBrokerAdapter(account.exchange).getBalances(account.id)));
  const positions = positionsByAccount.flat();
  const balances = balancesByAccount.flat();

  const totalEquity = scopedAccounts.reduce((sum, account) => sum + account.equityUsd, 0);
  const totalBalance = scopedAccounts.reduce((sum, account) => sum + account.balanceUsd, 0);
  const unrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const realizedPnl = positions.reduce((sum, position) => sum + position.realizedPnl, 0);
  const marginUsed = scopedAccounts.reduce((sum, account) => sum + account.marginUsed, 0);
  const availableMargin = scopedAccounts.reduce((sum, account) => sum + account.availableMargin, 0);
  const buyingPower = scopedAccounts.reduce((sum, account) => sum + account.buyingPower, 0);
  const dailyPnl = scopedAccounts.reduce((sum, account) => sum + account.dailyPnl, 0);
  const monthlyPnl = scopedAccounts.reduce((sum, account) => sum + account.monthlyPnl, 0);

  return {
    summary: {
      totalEquity,
      totalBalance,
      unrealizedPnl,
      realizedPnl,
      dailyPnl,
      weeklyPnl: 0,
      monthlyPnl,
      drawdownPct: 0,
      marginUsed,
      availableMargin,
      buyingPower,
      leverage: totalEquity > 0 ? buyingPower / totalEquity : 0,
      riskScore: scopedAccounts.length > 0 ? 1 : 0
    },
    accounts: scopedAccounts,
    balances,
    positions,
    orders: orders.filter((order) => scopedAccountSet.has(order.accountId)),
    curves: buildCurves()
  };
}

export function emptyPortfolioSnapshot(): PortfolioSnapshot {
  return {
    summary: {
      totalEquity: 0,
      totalBalance: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
      drawdownPct: 0,
      marginUsed: 0,
      availableMargin: 0,
      buyingPower: 0,
      leverage: 0,
      riskScore: 0
    },
    accounts: [],
    balances: [],
    positions: [],
    orders: [],
    curves: buildCurves(),
    orderSync: {}
  };
}

blackCoreEventBus.subscribe("execution.event", () => invalidatePortfolioSnapshot());
blackCoreEventBus.subscribe("position.updated", () => invalidatePortfolioSnapshot());

export async function connectExchangeAccount(draft: ExchangeConnectionDraft): Promise<PortfolioAccount> {
  const certification = getVenueCertification(draft.exchange);
  if (draft.exchange !== "mock" && !certification?.authReady) {
    throw new Error(`${draft.exchange.toUpperCase()} credential validation is not certified yet. This venue is ${certification?.executionMode ?? "unavailable"}.`);
  }

  try {
    const remoteAccount = await connectExchangeAccountViaApi(draft);
    if (remoteAccount) return remoteAccount;
  } catch (error) {
    if (draft.exchange !== "mock") {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Secure server credential validation failed: ${message}`);
    }
    console.error("Mock portfolio API connect failed, using local fallback.", error);
  }

  if (draft.exchange !== "mock") {
    throw new Error("Authenticated Supabase session required for secure credential validation.");
  }

  const id = createId("acct");
  const exchange = marketCatalog.find((item) => item.id === draft.exchange);

  await credentialStore.storeExchangeCredentials({
    accountId: id,
    exchange: draft.exchange,
    apiKey: draft.apiKey,
    apiSecret: draft.apiSecret,
    passphrase: draft.passphrase
  });

  const connection: AccountConnection = {
    id,
    exchange: draft.exchange,
    label: draft.accountName,
    permissions: ["read-account", "read-orders", "read-positions"],
    isPaper: false,
    connectedAt: Date.now()
  };
  const health = await getBrokerAdapter(draft.exchange).validateConnection(connection);

  const account: PortfolioAccount = {
    ...connection,
    accountName: draft.accountName || exchange?.label || draft.exchange,
    lastValidatedAt: health.checkedAt,
    status: health.status,
    apiHealth: health.apiHealth,
    latencyMs: health.latencyMs,
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
    riskControls: defaultRiskControls
  };

  accounts = [account, ...accounts];
  return account;
}

export function getPortfolioPositions(): PortfolioPosition[] {
  return [];
}
