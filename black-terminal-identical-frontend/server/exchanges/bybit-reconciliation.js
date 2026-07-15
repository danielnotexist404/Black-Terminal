import crypto from "node:crypto";
import {
  getBybitOpenOrdersSnapshot,
  getBybitStrategies,
  getBybitApiKeyInformation,
  getBybitPositions,
  getBybitInstrumentMetadata,
  getBybitAccountInfo,
  getBybitRiskLimits,
  getBybitOrderPriceLimit,
  getBybitWalletSnapshot,
  normalizeBybitPermissionReport,
  resolveBybitExecutionPolicy
} from "./bybit.js";
import { replaceBybitBalances, replaceBybitPositions } from "./bybit-snapshot-store.js";
import { settleSupabaseQuery } from "../supabase-query.js";

const ACTIVE_ORDER_STATUSES = ["pending", "accepted", "working", "partially-filled"];

export async function syncBybitSnapshotAndReconcile(supabase, userId, account, credentials, options = {}) {
  const startedAt = Date.now();
  const symbol = String(options.symbol || "BTCUSDT").toUpperCase();
  const marketKind = options.marketKind === "spot" ? "spot" : "perpetual";
  const [walletSnapshot, positionRows, openOrderSnapshot, strategies, metadata, accountState, riskLimits, priceLimit, apiKeyInfo] = await Promise.all([
    getBybitWalletSnapshot(credentials),
    getBybitPositions(credentials, { symbol, includeEmpty: true }),
    getBybitOpenOrdersSnapshot(credentials, {
      categories: options.orderCategories || ["linear", "spot"],
      settleCoin: options.settleCoin || "USDT",
      network: options.network || "mainnet"
    }),
    getBybitStrategies(credentials, { marketKind, symbol }).catch(() => []),
    getBybitInstrumentMetadata({ category: marketKind === "spot" ? "spot" : "linear", symbol }),
    getBybitAccountInfo(credentials),
    marketKind === "spot" ? Promise.resolve([]) : getBybitRiskLimits({ category: "linear", symbol }),
    getBybitOrderPriceLimit({ category: marketKind === "spot" ? "spot" : "linear", symbol }),
    getBybitApiKeyInformation(credentials)
  ]);
  const openOrders = openOrderSnapshot.orders.map((order) => ({
    ...order,
    accountId: account.id,
    connectionId: account.id,
    canonicalKey: `${order.network || "mainnet"}:${account.id}:bybit:${order.category || "unknown"}:${order.venueOrderId || order.orderId}`,
    venueUpdatedTime: Number(order.updatedTime || order.createdTime || Date.now()),
    lastSource: "rest-snapshot"
  }));
  const positions = positionRows.filter((position) => position.quantity > 0 && position.direction !== "flat");
  const balances = walletSnapshot.balances;
  const permissionReport = normalizeBybitPermissionReport(apiKeyInfo);
  const apiKeyFingerprint = crypto.createHash("sha256").update(String(credentials.apiKey || account.id)).digest("hex").slice(0, 24);
  const venueAccountId = String(apiKeyInfo?.userID || apiKeyInfo?.userId || apiKeyInfo?.parentUid || apiKeyInfo?.uid || apiKeyFingerprint);
  const canonicalConnectionId = `bybit:${venueAccountId}`;
  for (const order of openOrders) {
    order.connectionId = canonicalConnectionId;
    order.venueAccountId = venueAccountId;
    order.canonicalKey = `${order.network || "mainnet"}:${canonicalConnectionId}:bybit:${order.category || "unknown"}:${order.venueOrderId || order.orderId}`;
  }
  const permissionExecutionState = resolveBybitExecutionPolicy(permissionReport);
  const executionState = {
    ...permissionExecutionState,
    tradingEnabled: permissionExecutionState.tradingEnabled && openOrderSnapshot.health.verified,
    readOnly: permissionExecutionState.readOnly || !openOrderSnapshot.health.verified,
    readinessReason: openOrderSnapshot.health.verified
      ? permissionExecutionState.readinessReason
      : `Bybit order synchronization is degraded. Failed categories: ${openOrderSnapshot.health.failedCategories.map((failure) => failure.category).join(", ")}.`
  };

  const [localBalancesResult, localPositionsResult, localOrdersResult] = await Promise.all([
    supabase.from("account_balances").select("*").eq("account_id", account.id),
    supabase.from("account_positions").select("*").eq("account_id", account.id),
    supabase
      .from("execution_orders")
      .select("*")
      .eq("user_id", userId)
      .eq("account_id", account.id)
      .in("status", ACTIVE_ORDER_STATUSES)
  ]);

  if (localBalancesResult.error) throw localBalancesResult.error;
  if (localPositionsResult.error) throw localPositionsResult.error;
  if (localOrdersResult.error) throw localOrdersResult.error;

  const localBalances = localBalancesResult.data || [];
  const localPositions = localPositionsResult.data || [];
  const localOrders = localOrdersResult.data || [];
  const changes = [];

  await upsertBalances(supabase, account.id, balances);
  await upsertPositions(supabase, account.id, positions);
  await updateKnownOrders(supabase, userId, account.id, openOrders);

  changes.push(...diffBalances(localBalances, balances));
  changes.push(...diffPositions(localPositions, positions));
  changes.push(...diffOrders(localOrders, openOrders));

  const stalePositions = findStalePositions(localPositions, positions);
  if (stalePositions.length > 0) {
    await Promise.all(stalePositions.map((position) =>
      supabase
        .from("account_positions")
        .update({
          quantity: 0,
          unrealized_pnl: 0,
          updated_at: new Date().toISOString()
        })
        .eq("id", position.id)
    ));
    changes.push(...stalePositions.map((position) => ({
      type: "position_missing_on_venue",
      symbol: position.symbol,
      direction: position.direction
    })));
  }

  const externalStateChanged = changes.length > 0;
  const accountPatch = {
    status: openOrderSnapshot.health.stale ? "degraded" : "connected",
    api_health: openOrderSnapshot.health.stale ? "warning" : "healthy",
    latency_ms: Date.now() - startedAt,
    is_read_only: executionState.readOnly,
    trading_enabled: executionState.tradingEnabled,
    permissions: executionState.permissions
  };
  const riskPatch = {
    read_only_mode: executionState.readOnly,
    trading_enabled: executionState.tradingEnabled,
    allowed_symbols: executionState.allowedSymbols,
    max_position_usd: executionState.maxNotionalUsd
  };
  const [accountUpdate, riskUpdate] = await Promise.all([
    supabase.from("exchange_accounts").update(accountPatch).eq("id", account.id).eq("user_id", userId),
    supabase.from("account_risk_controls").update(riskPatch).eq("account_id", account.id)
  ]);
  if (accountUpdate.error) throw accountUpdate.error;
  if (riskUpdate.error) throw riskUpdate.error;
  Object.assign(account, accountPatch);

  if (!executionState.tradingEnabled) {
    console.warn("[bybit-execution-policy-blocked]", {
      account: String(account.id || "").slice(-6),
      readinessReason: executionState.readinessReason,
      venueTradingPermission: permissionReport.trading,
      withdrawalPermission: permissionReport.withdrawal,
      allowedSymbols: executionState.allowedSymbols,
      maxNotionalUsd: executionState.maxNotionalUsd
    });
  }

  await settleSupabaseQuery(supabase.from("execution_audit_logs").insert({
    user_id: userId,
    account_id: account.id,
    event_type: externalStateChanged ? "external_state_change_detected" : "position_synced",
    severity: externalStateChanged ? "warning" : "info",
    message: externalStateChanged
      ? `Bybit venue state differed from local state for ${account.account_name || account.id}.`
      : "Bybit snapshot reconciliation completed with no material differences.",
    metadata: {
      venueId: "bybit",
      symbol,
      changes,
      balances: balances.length,
      positions: positions.length,
      openOrders: openOrders.length,
      orderSync: openOrderSnapshot.health,
      strategies: strategies.length,
      latencyMs: Date.now() - startedAt
    }
  }));

  return {
    accountId: account.id,
    exchange: "bybit",
    network: "mainnet",
    balances,
    accountMetrics: walletSnapshot.accountMetrics,
    instrumentRules: metadata[0] || null,
    selectedPosition: positionRows.find((position) => position.symbol === symbol && position.positionIdx === 0) || positionRows.find((position) => position.symbol === symbol) || null,
    accountState,
    riskLimits,
    priceLimit,
    executionState,
    positions,
    openOrders,
    orderSync: openOrderSnapshot.health,
    strategies,
    externalStateChanged,
    changes,
    syncedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt
  };
}

async function upsertBalances(supabase, accountId, balances) {
  await replaceBybitBalances(supabase, accountId, balances);
}

async function upsertPositions(supabase, accountId, positions) {
  await replaceBybitPositions(supabase, accountId, positions);
}

async function updateKnownOrders(supabase, userId, accountId, openOrders) {
  await Promise.all(openOrders.filter((order) => order.orderId).map((order) =>
    supabase
      .from("execution_orders")
      .update({
        status: order.status,
        filled_quantity: order.filledQuantity,
        average_fill_price: order.averageFillPrice,
        client_order_id: order.clientOrderId || null
      })
      .eq("user_id", userId)
      .eq("account_id", accountId)
      .eq("exchange_order_id", order.orderId)
  ));
}

function diffBalances(localRows, venueRows) {
  const localByAsset = new Map(localRows.map((row) => [String(row.asset).toUpperCase(), Number(row.total || 0)]));
  return venueRows.flatMap((row) => {
    const local = localByAsset.get(String(row.asset).toUpperCase()) ?? 0;
    return Math.abs(local - Number(row.total || 0)) > 0.00000001
      ? [{ type: "balance_changed", asset: row.asset, local, venue: Number(row.total || 0) }]
      : [];
  });
}

function diffPositions(localRows, venueRows) {
  const localByKey = new Map(localRows.map((row) => [positionKey(row), Number(row.quantity || 0)]));
  return venueRows.flatMap((row) => {
    const local = localByKey.get(positionKey(row)) ?? 0;
    return Math.abs(local - Number(row.quantity || 0)) > 0.00000001
      ? [{ type: "position_quantity_changed", symbol: row.symbol, direction: row.direction, local, venue: Number(row.quantity || 0) }]
      : [];
  });
}

function diffOrders(localRows, venueRows) {
  const venueOrderIds = new Set(venueRows.map((row) => row.orderId).filter(Boolean));
  return localRows.flatMap((row) => {
    if (!row.exchange_order_id) return [];
    return venueOrderIds.has(row.exchange_order_id)
      ? []
      : [{ type: "order_not_in_open_snapshot", orderId: row.id, exchangeOrderId: row.exchange_order_id, status: row.status }];
  });
}

function findStalePositions(localRows, venueRows) {
  const venueKeys = new Set(venueRows.map(positionKey));
  return localRows.filter((row) => Number(row.quantity || 0) > 0 && !venueKeys.has(positionKey(row)));
}

function positionKey(row) {
  return `${String(row.symbol || "").toUpperCase()}:${String(row.direction || "").toLowerCase()}`;
}
