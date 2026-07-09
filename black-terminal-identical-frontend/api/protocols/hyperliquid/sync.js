import {
  applyCors,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../../server/portfolio-api.js";
import {
  loadHyperliquidCredential,
  syncHyperliquidAccount,
  writeHyperliquidRelayEvent
} from "../../../server/protocols/hyperliquid.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["accountId"]);

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    assertHyperliquidAccount(account);
    const credential = await loadHyperliquidCredential(supabase, user.id, { accountId: account.id });

    const before = await supabase
      .from("account_positions")
      .select("symbol,direction,quantity,average_price,current_price")
      .eq("account_id", account.id);
    if (before.error) throw before.error;

    const payload = await syncHyperliquidAccount(supabase, account, credential);
    const beforeKeys = new Set((before.data || []).map((row) => `${row.symbol}:${row.direction}:${Number(row.quantity || 0)}`));
    const afterKeys = new Set(payload.positions.map((row) => `${row.symbol}:${row.direction}:${Number(row.quantity || 0)}`));
    const externalStateChanged = beforeKeys.size !== afterKeys.size || Array.from(afterKeys).some((key) => !beforeKeys.has(key));

    await writeHyperliquidRelayEvent(supabase, {
      userId: user.id,
      accountId: account.id,
      connectionId: credential.connection_id,
      credentialId: credential.id,
      eventType: externalStateChanged ? "external_state_change_detected" : "position_synced",
      severity: externalStateChanged ? "warning" : "info",
      message: externalStateChanged
        ? "Hyperliquid sync detected account state changes outside Black Terminal."
        : "Hyperliquid account state synchronized.",
      metadata: {
        positions: payload.positions.length,
        openOrders: payload.orders.length,
        fills: payload.fills.length
      }
    });

    return res.status(200).json({
      sync: {
        accountId: account.id,
        exchange: "hyperliquid",
        network: credential.network,
        balances: payload.balances,
        positions: payload.positions,
        openOrders: payload.orders,
        fills: payload.fills,
        externalStateChanged,
        syncedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function assertHyperliquidAccount(account) {
  if (account.exchange !== "hyperliquid") {
    const error = new Error("This protocol route only accepts Hyperliquid accounts.");
    error.statusCode = 400;
    throw error;
  }
}
