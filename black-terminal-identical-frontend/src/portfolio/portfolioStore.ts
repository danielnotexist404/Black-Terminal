import { getBrokerAdapter } from "../broker/brokerRegistry";
import { createId } from "../core/ids";
import { TauriSecureCredentialStore } from "../core/secureCredentialStore";
import type { AccountConnection, Balance, OrderUpdate } from "../execution/types";
import { marketCatalog } from "../market-data/marketCatalog";
import type { PortfolioPosition } from "../positions/types";
import { defaultRiskControls } from "../risk/types";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "./types";

const credentialStore = new TauriSecureCredentialStore();

const seedAccounts: PortfolioAccount[] = [
  {
    id: "acct-primary-bybit",
    exchange: "bybit",
    label: "Bybit Prime",
    accountName: "Bybit Prime",
    permissions: ["read-account", "read-orders", "read-positions"],
    isPaper: false,
    connectedAt: Date.now() - 1000 * 60 * 60 * 24 * 18,
    lastValidatedAt: Date.now() - 1000 * 46,
    status: "read-only",
    apiHealth: "healthy",
    latencyMs: 31,
    balanceUsd: 124_860,
    equityUsd: 127_472,
    marginUsed: 15_701,
    availableMargin: 111_771,
    buyingPower: 558_855,
    leverage: 4.4,
    dailyPnl: 1_182,
    monthlyPnl: 8_944,
    openPositions: 2,
    openOrders: 4,
    riskControls: defaultRiskControls
  },
  {
    id: "acct-binance-hedge",
    exchange: "binance",
    label: "Binance Hedge",
    accountName: "Binance Hedge",
    permissions: ["read-account", "read-orders", "read-positions"],
    isPaper: false,
    connectedAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    lastValidatedAt: Date.now() - 1000 * 72,
    status: "connected",
    apiHealth: "healthy",
    latencyMs: 44,
    balanceUsd: 81_420,
    equityUsd: 82_011,
    marginUsed: 6_280,
    availableMargin: 75_731,
    buyingPower: 378_655,
    leverage: 2.9,
    dailyPnl: -214,
    monthlyPnl: 2_140,
    openPositions: 1,
    openOrders: 2,
    riskControls: { ...defaultRiskControls, tradingEnabled: true, maxLeverage: 3 }
  }
];

let accounts = [...seedAccounts];
let orders: OrderUpdate[] = [];

function buildCurves() {
  const equity = [201_000, 204_200, 202_880, 207_400, 206_150, 209_483].map((value, index) => ({
    time: `D-${5 - index}`,
    value
  }));

  return {
    equity,
    drawdown: [0.8, 1.4, 2.6, 1.2, 1.9, 1.1].map((value, index) => ({ time: `D-${5 - index}`, value })),
    dailyReturns: [0.42, 1.58, -0.65, 2.23, -0.6, 1.62].map((value, index) => ({ time: `D-${5 - index}`, value })),
    exposure: [
      { label: "BTC", value: 54 },
      { label: "ETH", value: 26 },
      { label: "SOL", value: 12 },
      { label: "Cash", value: 8 }
    ]
  };
}

export async function getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
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
      weeklyPnl: 4_680,
      monthlyPnl,
      drawdownPct: 1.35,
      marginUsed,
      availableMargin,
      buyingPower,
      leverage: totalEquity > 0 ? buyingPower / totalEquity : 0,
      riskScore: 31
    },
    accounts,
    balances,
    positions,
    orders,
    curves: buildCurves()
  };
}

export async function connectExchangeAccount(draft: ExchangeConnectionDraft): Promise<PortfolioAccount> {
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
