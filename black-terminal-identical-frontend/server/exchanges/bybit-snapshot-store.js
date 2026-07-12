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

export async function replaceBybitPositions(supabase, accountId, positions) {
  await deleteAccountRows(supabase, "account_positions", accountId);
  if (positions.length === 0) return;

  const { error } = await supabase.from("account_positions").insert(
    positions.map((position) => ({
      account_id: accountId,
      exchange: "bybit",
      symbol: position.symbol,
      direction: position.direction,
      quantity: position.quantity,
      average_price: position.averagePrice,
      current_price: position.currentPrice,
      unrealized_pnl: position.unrealizedPnl,
      realized_pnl: position.realizedPnl,
      margin: position.margin,
      leverage: position.leverage,
      liquidation_price: position.liquidationPrice,
      stop_loss: position.stopLoss,
      take_profit: position.takeProfit,
      opened_at: position.openedAt ? new Date(position.openedAt).toISOString() : null,
      updated_at: new Date().toISOString()
    }))
  );
  if (error) throw snapshotStorageError("insert account positions", error);
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
