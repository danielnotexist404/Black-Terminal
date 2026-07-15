import crypto from "node:crypto";
import {
  applyCors,
  decryptCredentialPayload,
  requireMethod,
  requireUser,
  sendError,
  toCamelAccount
} from "../../server/portfolio-api.js";
import { syncBybitSnapshotAndReconcile } from "../../server/exchanges/bybit-reconciliation.js";
import { loadHyperliquidCredential, syncHyperliquidAccount } from "../../server/protocols/hyperliquid.js";

function num(value) {
  return Number(value || 0);
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "GET");

    const { supabase, user } = await requireUser(req);

    const { data: accountRows, error: accountsError } = await supabase
      .from("exchange_accounts")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (accountsError) throw accountsError;
    const accounts = await selectCanonicalAccounts(supabase, accountRows || []);

    const accountIds = accounts.map((account) => account.id);

    if (accountIds.length === 0) {
      return res.status(200).json({
        summary: emptySummary(),
        accounts: [],
        balances: [],
        positions: [],
        orders: []
      });
    }

    const liveSyncByAccount = await syncLiveAccounts(supabase, user.id, accounts);

    const [riskResult, balancesResult, positionsResult, ordersResult] = await Promise.all([
      supabase.from("account_risk_controls").select("*").in("account_id", accountIds),
      supabase.from("account_balances").select("*").in("account_id", accountIds),
      supabase.from("account_positions").select("*").in("account_id", accountIds),
      supabase
        .from("execution_orders")
        .select("*")
        .eq("user_id", user.id)
        .in("account_id", accountIds)
        .order("created_at", { ascending: false })
        .limit(100)
    ]);

    if (riskResult.error) throw riskResult.error;
    if (balancesResult.error) throw balancesResult.error;
    if (positionsResult.error) throw positionsResult.error;
    if (ordersResult.error) throw ordersResult.error;

    const riskByAccount = new Map(riskResult.data.map((row) => [row.account_id, row]));
    const balances = balancesResult.data || [];
    const positions = positionsResult.data || [];
    const persistedOrders = (ordersResult.data || []).filter((order) => ["pending", "accepted", "working", "partially-filled"].includes(order.status));
    const liveOrders = [...liveSyncByAccount.values()].flatMap((sync) => sync.openOrders || []);
    const orders = mergeActiveOrders(persistedOrders, liveOrders, liveSyncByAccount);

    const totalBalance = balances.reduce((sum, row) => sum + num(row.usd_value), 0);
    const unrealizedPnl = positions.reduce((sum, row) => sum + num(row.unrealized_pnl), 0);
    const realizedPnl = positions.reduce((sum, row) => sum + num(row.realized_pnl), 0);
    const marginUsed = positions.reduce((sum, row) => sum + num(row.margin), 0);
    const totalEquity = totalBalance + unrealizedPnl;
    const availableMargin = Math.max(0, totalEquity - marginUsed);

    return res.status(200).json({
      summary: {
        totalEquity,
        totalBalance,
        unrealizedPnl,
        realizedPnl,
        dailyPnl: 0,
        weeklyPnl: 0,
        monthlyPnl: 0,
        drawdownPct: 0,
        marginUsed,
        availableMargin,
        buyingPower: availableMargin * 5,
        leverage: totalEquity > 0 ? (availableMargin * 5) / totalEquity : 0,
        riskScore: calculateRiskScore({ totalEquity, marginUsed })
      },
      accounts: accounts.map((account) => toCamelAccount(account, riskByAccount.get(account.id))),
      balances: balances.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        asset: row.asset,
        free: num(row.free),
        locked: num(row.locked),
        total: num(row.total),
        usdValue: row.usd_value === null ? null : num(row.usd_value),
        updatedAt: row.updated_at
      })),
      positions: positions.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        exchange: row.exchange,
        symbol: row.symbol,
        direction: row.direction,
        quantity: num(row.quantity),
        averagePrice: row.average_price === null ? null : num(row.average_price),
        currentPrice: row.current_price === null ? null : num(row.current_price),
        unrealizedPnl: num(row.unrealized_pnl),
        realizedPnl: num(row.realized_pnl),
        margin: num(row.margin),
        leverage: num(row.leverage),
        liquidationPrice: row.liquidation_price === null ? null : num(row.liquidation_price),
        stopLoss: row.stop_loss === null ? null : num(row.stop_loss),
        takeProfit: row.take_profit === null ? null : num(row.take_profit),
        openedAt: row.opened_at,
        updatedAt: row.updated_at
      })),
      orders,
      orderSync: Object.fromEntries([...liveSyncByAccount.entries()].map(([accountId, sync]) => [accountId, sync.orderSync]))
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function selectCanonicalAccounts(supabase, accounts) {
  const bybitAccountIds = accounts.filter((account) => account.exchange === "bybit").map((account) => account.id);
  if (bybitAccountIds.length < 2) return accounts;
  const { data: credentials, error } = await supabase
    .from("exchange_credentials")
    .select("account_id, encrypted_payload")
    .in("account_id", bybitAccountIds);
  if (error || !credentials) return accounts;

  const fingerprintByAccount = new Map(credentials.map((credential) => [
    credential.account_id,
    portfolioCredentialFingerprint(credential.encrypted_payload)
  ]));
  const seen = new Set();
  return accounts.filter((account) => {
    if (account.exchange !== "bybit") return true;
    const fingerprint = fingerprintByAccount.get(account.id);
    if (!fingerprint) return true;
    const key = `bybit:${fingerprint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function portfolioCredentialFingerprint(encryptedPayload) {
  try {
    const credentials = decryptCredentialPayload(encryptedPayload);
    const apiKey = String(credentials?.apiKey || "");
    return apiKey ? crypto.createHash("sha256").update(apiKey).digest("hex") : null;
  } catch {
    return null;
  }
}

async function syncLiveAccounts(supabase, userId, accounts) {
  const liveSyncByAccount = new Map();
  const bybitAccounts = accounts.filter((account) => account.exchange === "bybit");

  for (const account of bybitAccounts) {
    try {
      const { data: credential, error } = await supabase
        .from("exchange_credentials")
        .select("encrypted_payload")
        .eq("account_id", account.id)
        .single();

      if (error || !credential) continue;
      const credentials = decryptCredentialPayload(credential.encrypted_payload);
      const sync = await syncBybitSnapshotAndReconcile(supabase, userId, account, credentials, { symbol: "BTCUSDT" });
      liveSyncByAccount.set(account.id, sync);
    } catch (error) {
      console.error(`Bybit sync failed for account ${account.id}`, error);
      liveSyncByAccount.set(account.id, {
        openOrders: [],
        orderSync: {
          network: "mainnet",
          requestedCategories: ["linear", "spot"],
          successfulCategories: [],
          failedCategories: [{ category: "account", error: error instanceof Error ? error.message : String(error) }],
          ordersPerCategory: {},
          activeOrderCount: 0,
          verified: false,
          stale: true,
          syncedAt: Date.now(),
          latencyMs: 0
        }
      });
      await supabase
        .from("exchange_accounts")
        .update({
          status: "degraded",
          api_health: "warning"
        })
        .eq("id", account.id)
        .eq("user_id", userId);
    }
  }

  const hyperliquidAccounts = accounts.filter((account) => account.exchange === "hyperliquid");
  for (const account of hyperliquidAccounts) {
    try {
      const credential = await loadHyperliquidCredential(supabase, userId, { accountId: account.id });
      await syncHyperliquidAccount(supabase, account, credential);
      await supabase
        .from("exchange_accounts")
        .update({
          status: "connected",
          api_health: "healthy"
        })
        .eq("id", account.id)
        .eq("user_id", userId);
    } catch (error) {
      console.error(`Hyperliquid sync failed for account ${account.id}`, error);
      await supabase
        .from("exchange_accounts")
        .update({
          status: "degraded",
          api_health: "warning"
        })
        .eq("id", account.id)
        .eq("user_id", userId);
    }
  }
  return liveSyncByAccount;
}

function mergeActiveOrders(persistedOrders, liveOrders, liveSyncByAccount) {
  const merged = new Map();
  for (const order of persistedOrders) {
    if (liveSyncByAccount.get(order.account_id)?.orderSync?.verified) continue;
    const venueOrderId = order.exchange_order_id || order.id;
    merged.set(`mainnet:${order.account_id}:${order.exchange}:unknown:${venueOrderId}`, order);
  }
  for (const order of liveOrders) {
    const key = order.canonicalKey || `${order.network || "mainnet"}:${order.connectionId || order.accountId}:${order.exchange}:${order.category || "unknown"}:${order.venueOrderId || order.orderId}`;
    for (const existingKey of merged.keys()) {
      if (existingKey.includes(`:${order.accountId}:${order.exchange}:`) && existingKey.endsWith(`:${order.venueOrderId || order.orderId}`)) {
        merged.delete(existingKey);
      }
    }
    const current = merged.get(key);
    const incomingVersion = Number(order.venueUpdatedTime || order.updatedTime || order.createdTime || 0);
    const currentVersion = Number(current?.venueUpdatedTime || current?.updatedTime || current?.updated_at || current?.createdTime || 0);
    if (!current || incomingVersion >= currentVersion) merged.set(key, { ...order, canonicalKey: key });
  }
  return [...merged.values()].sort((a, b) => Number(b.updatedTime || b.updated_at || b.createdTime || 0) - Number(a.updatedTime || a.updated_at || a.createdTime || 0));
}

function emptySummary() {
  return {
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
  };
}

function calculateRiskScore({ totalEquity, marginUsed }) {
  if (totalEquity <= 0) return 0;
  return Math.min(100, Math.round((marginUsed / totalEquity) * 100));
}
