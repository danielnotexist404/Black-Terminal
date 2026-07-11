import {
  applyCors,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../server/portfolio-api.js";
import { getBybitDiagnostics } from "../../server/exchanges/bybit.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");

    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["accountId"]);

    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    const { data: credential, error: credentialError } = await supabase
      .from("exchange_credentials")
      .select("encrypted_payload")
      .eq("account_id", account.id)
      .single();

    if (credentialError || !credential) {
      const missing = new Error("Missing encrypted credentials for diagnostics.");
      missing.statusCode = 404;
      throw missing;
    }

    const credentials = decryptCredentialPayload(credential.encrypted_payload);
    const diagnostics = await runVenueDiagnostics(account.exchange, credentials, req.body);
    await persistDiagnostics(supabase, user.id, account, diagnostics);

    return res.status(200).json({ diagnostics });
  } catch (error) {
    return sendError(res, error);
  }
}

async function runVenueDiagnostics(exchange, credentials, body) {
  if (exchange === "bybit") {
    return getBybitDiagnostics(credentials, { symbol: String(body.symbol || "BTCUSDT").toUpperCase() });
  }

  const unsupported = new Error(`${exchange} diagnostics are not certified yet.`);
  unsupported.statusCode = 501;
  throw unsupported;
}

async function persistDiagnostics(supabase, userId, account, diagnostics) {
  const now = new Date().toISOString();
  const writes = [
    supabase.from("adapter_certifications").upsert({
      venue_id: diagnostics.venueId,
      provider: diagnostics.provider,
      category: "centralized-exchange",
      execution_mode: diagnostics.executionMode,
      network: diagnostics.network,
      readiness: diagnostics.readiness,
      implementation_status: "partial",
      market_data_ready: diagnostics.certification.marketDataReady,
      auth_ready: diagnostics.certification.authReady,
      account_read_ready: diagnostics.certification.accountReadReady,
      balances_ready: diagnostics.certification.balancesReady,
      positions_ready: diagnostics.certification.positionsReady,
      open_orders_ready: diagnostics.certification.openOrdersReady,
      fills_ready: false,
      private_streams_ready: diagnostics.certification.privateStreamsReady,
      market_order_certified: false,
      limit_order_certified: false,
      cancel_certified: false,
      modify_certified: false,
      tpsl_certified: false,
      reconnect_certified: false,
      mainnet_validated: diagnostics.certification.mainnetValidated,
      supported_products: ["spot", "perpetual"],
      supported_order_types: [],
      capabilities: diagnostics.certification,
      limitations: diagnostics.permissions.warnings,
      last_validated_at: now,
      updated_at: now
    }, { onConflict: "venue_id,network" }),
    supabase.from("connection_health_snapshots").insert({
      user_id: userId,
      account_id: account.id,
      venue_id: diagnostics.venueId,
      provider: diagnostics.provider,
      category: "centralized-exchange",
      network: diagnostics.network,
      readiness: diagnostics.readiness,
      execution_mode: diagnostics.executionMode,
      public_stream: diagnostics.publicStream,
      private_stream: diagnostics.privateStream,
      authentication: diagnostics.authentication,
      synchronization: diagnostics.synchronization,
      latency_ms: diagnostics.latencyMs,
      reconnect_count: 0,
      clock_skew_ms: diagnostics.time.clockSkewMs,
      metadata_freshness_ms: 0,
      rate_limit_usage: diagnostics.rateLimitUsage,
      health: diagnostics,
      captured_at: now
    }),
    supabase.from("venue_time_sync_status").upsert({
      venue_id: diagnostics.venueId,
      network: diagnostics.network,
      server_time: diagnostics.time.serverTime,
      local_time: new Date(diagnostics.time.localTimeMs).toISOString(),
      clock_skew_ms: diagnostics.time.clockSkewMs,
      request_window_ms: 5000,
      status: Math.abs(diagnostics.time.clockSkewMs) > 3000 ? "resync-required" : "ok",
      last_successful_sync_at: now,
      metadata: diagnostics.time,
      updated_at: now
    }, { onConflict: "venue_id,network" }),
    ...diagnostics.metadata.map((item) => supabase.from("venue_metadata_cache").upsert({
      venue_id: diagnostics.venueId,
      network: diagnostics.network,
      native_symbol: item.nativeSymbol,
      canonical_base: item.canonicalBase,
      canonical_quote: item.canonicalQuote,
      settlement_asset: item.settlementAsset,
      market_type: item.marketType,
      contract_type: item.contractType,
      expiry: item.expiry,
      contract_multiplier: item.contractMultiplier,
      tick_size: item.tickSize,
      quantity_step: item.quantityStep,
      min_quantity: item.minQuantity,
      min_notional: item.minNotional,
      max_quantity: item.maxQuantity,
      price_precision: item.pricePrecision,
      quantity_precision: item.quantityPrecision,
      leverage_limits: item.leverageLimits,
      supported_margin_modes: item.supportedMarginModes,
      supported_time_in_force: item.supportedTimeInForce,
      supported_trigger_behavior: item.supportedTriggerBehavior,
      trading_status: item.tradingStatus,
      raw_metadata: item.raw,
      loaded_at: now,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }, { onConflict: "venue_id,network,native_symbol,market_type" }))
  ];

  const results = await Promise.allSettled(writes);
  const failed = results.find((result) => result.status === "fulfilled" && result.value?.error);
  if (failed?.status === "fulfilled") {
    await supabase.from("execution_audit_logs").insert({
      user_id: userId,
      account_id: account.id,
      event_type: "connection_diagnostics_persist_failed",
      severity: "warning",
      message: failed.value.error.message,
      metadata: { venueId: diagnostics.venueId }
    }).catch(() => null);
  }

  await supabase.from("execution_audit_logs").insert({
    user_id: userId,
    account_id: account.id,
    event_type: "connection_diagnostics_run",
    severity: "info",
    message: `${diagnostics.provider} diagnostics completed.`,
    metadata: {
      venueId: diagnostics.venueId,
      readiness: diagnostics.readiness,
      latencyMs: diagnostics.latencyMs,
      clockSkewMs: diagnostics.time.clockSkewMs,
      openOrders: diagnostics.openOrders.length,
      balances: diagnostics.balances.length,
      positions: diagnostics.positions.length
    }
  }).catch(() => null);
}
