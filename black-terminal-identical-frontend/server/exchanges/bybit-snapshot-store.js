import { canonicalizeBybitPositions } from "./bybit-position-identity.js";

export async function replaceBybitBalances(supabase, accountId, balances) {
  await deleteAccountRows(supabase, "account_balances", accountId);
  if (balances.length === 0) return;

  const { error } = await supabase.from("account_balances").insert(
    balances.map((balance) => ({
      account_id: accountId,
      asset: balance.asset,
      free: balance.free,
      locked: balance.locked,
      total: balance.total,
      usd_value: balance.usdValue,
      updated_at: new Date().toISOString()
    }))
  );
  if (error) throw snapshotStorageError("insert account balances", error);
}

export async function replaceBybitPositions(supabase, accountId, positions, snapshotStartedAt = Date.now()) {
  const canonical = canonicalizeBybitPositions(positions, accountId);
  const rows = canonical.map((position) => ({
    category: position.category,
    marketKind: position.marketKind,
    positionIdx: position.positionIdx,
    canonicalKey: position.canonicalKey,
    symbol: position.symbol,
    direction: position.direction,
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    currentPrice: position.currentPrice,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl,
    margin: position.margin,
    leverage: position.leverage,
    liquidationPrice: position.liquidationPrice,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    openedAt: position.openedAt ? new Date(position.openedAt).toISOString() : null,
    updatedAt: position.updatedAt ? new Date(position.updatedAt).toISOString() : new Date(snapshotStartedAt).toISOString()
  }));
  const { data, error } = await supabase.rpc("replace_bybit_positions_snapshot_v1", {
    p_account_id: accountId,
    p_snapshot_started_at: new Date(snapshotStartedAt).toISOString(),
    p_rows: rows
  });
  if (error) throw snapshotStorageError("replace account position snapshot", error);
  return Array.isArray(data) ? data[0] : data;
}

export function describeSupabaseError(error) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error || "Unknown Supabase error.");

  return [error.message, error.details, error.hint, error.code ? `code ${error.code}` : ""]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" | ") || "Unknown Supabase error.";
}

async function deleteAccountRows(supabase, table, accountId) {
  const { error } = await supabase.from(table).delete().eq("account_id", accountId);
  if (error) throw snapshotStorageError(`clear ${table}`, error);
}

function snapshotStorageError(operation, error) {
  const message = describeSupabaseError(error);
  const wrapped = new Error(`Supabase failed to ${operation}: ${message}`);
  wrapped.statusCode = 500;
  wrapped.code = "BYBIT_SNAPSHOT_STORAGE_FAILED";
  wrapped.publicDetails = {
    operation,
    supabaseCode: error?.code || null,
    supabaseHint: error?.hint || null
  };
  return wrapped;
}
