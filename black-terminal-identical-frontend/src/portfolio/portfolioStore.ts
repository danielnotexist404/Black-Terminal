import { getBrokerAdapter } from "../broker/brokerRegistry";
import { createId } from "../core/ids";
import { TauriSecureCredentialStore } from "../core/secureCredentialStore";
import type { AccountConnection, OrderUpdate } from "../execution/types";
import { marketCatalog } from "../market-data/marketCatalog";
import type { PortfolioPosition } from "../positions/types";
import { defaultRiskControls } from "../risk/types";
import { connectExchangeAccountViaApi, fetchPortfolioSnapshotFromApi } from "./portfolioApiClient";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "./types";

const credentialStore = new TauriSecureCredentialStore();

let accounts: PortfolioAccount[] = [];
let orders: OrderUpdate[] = [];

function buildCurves() {
  return {
    equity: [],
    drawdown: [],
    dailyReturns: [],
    exposure: []
  };
}

export async function getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
  try {
    const remoteSnapshot = await fetchPortfolioSnapshotFromApi();
    if (remoteSnapshot) return remoteSnapshot;
  } catch (error) {
    console.error("Portfolio API snapshot failed, using local fallback.", error);
  }

  const positionsByAccount = await Promise.all(accounts.map((account) => getBrokerAdapter(account.exchange).getPositions(account.id)));
  const balancesByAccount = await Promise.all(accounts.map((account) => getBrokerAdapter(account.exchange).getBalances(account.id)));
  const positions = positionsByAccount.flat();
  const balances = balancesByAccount.flat();

  const totalEquity = accounts.reduce((sum, account) => sum + account.equityUsd, 0);
  const totalBalance = accounts.reduce((sum, account) => sum + account.balanceUsd, 0);
  const unrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const realizedPnl = positions.reduce((sum, position) => sum + position.realizedPnl, 0);
  const marginUsed = accounts.reduce((sum, account) => sum + account.marginUsed, 0);
  const availableMargin = accounts.reduce((sum, account) => sum + account.availableMargin, 0);
  const buyingPower = accounts.reduce((sum, account) => sum + account.buyingPower, 0);
  const dailyPnl = accounts.reduce((sum, account) => sum + account.dailyPnl, 0);
  const monthlyPnl = accounts.reduce((sum, account) => sum + account.monthlyPnl, 0);

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
      riskScore: accounts.length > 0 ? 1 : 0
    },
    accounts,
    balances,
    positions,
    orders,
    curves: buildCurves()
  };
}

export async function connectExchangeAccount(draft: ExchangeConnectionDraft): Promise<PortfolioAccount> {
  try {
    const remoteAccount = await connectExchangeAccountViaApi(draft);
    if (remoteAccount) return remoteAccount;
  } catch (error) {
    console.error("Portfolio API connect failed, using local fallback.", error);
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
