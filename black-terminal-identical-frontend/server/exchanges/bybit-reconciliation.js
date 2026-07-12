import {
  getBybitBalances,
  getBybitOpenOrders,
  getBybitPositions
} from "./bybit.js";
import { replaceBybitBalances, replaceBybitPositions } from "./bybit-snapshot-store.js";

const ACTIVE_ORDER_STATUSES = ["pending", "accepted", "working", "partially-filled"];

export async function syncBybitSnapshotAndReconcile(supabase, userId, account, credentials, options = {}) {
  const startedAt = Date.now();
  const symbol = String(options.symbol || "BTCUSDT").toUpperCase();
  const [balances, positions, openOrders] = await Promise.all([
    getBybitBalances(credentials),
    getBybitPositions(credentials),
    getBybitOpenOrders(credentials, { category: options.marketKind === "spot" ? "spot" : "linear", symbol })
  ]);

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
  await supabase.from("exchange_accounts").update({
    status: "connected",
    api_health: "healthy",
    latency_ms: Date.now() - startedAt
  }).eq("id", account.id).eq("user_id", userId);

  await supabase.from("execution_audit_logs").insert({
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
      latencyMs: Date.now() - startedAt
    }
  }).catch(() => null);

  return {
    accountId: account.id,
    exchange: "bybit",
    network: "mainnet",
    balances,
    positions,
    openOrders,
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
