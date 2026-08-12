import {
  applyCors,
  checkOrderRisk,
  decryptCredentialPayload,
  getOwnedAccount,
  requireFields,
  requireMethod,
  requireUser,
  sendError
} from "../../portfolio-api.js";
import { settleSupabaseQuery } from "../../supabase-query.js";
import { createCloudExchangeAdapter } from "../../cloud-execution/adapters/registry.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  const routeStartedAt = performance.now();
  const timings = [];

  try {
    requireMethod(req, "POST");

    let stageStartedAt = performance.now();
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["accountId", "exchange", "symbol", "side", "orderType", "quantity"]);
    timings.push(["auth", performance.now() - stageStartedAt]);

    stageStartedAt = performance.now();
    const account = await getOwnedAccount(supabase, user.id, req.body.accountId);
    timings.push(["account", performance.now() - stageStartedAt]);
    const requestedClientOrderId = String(req.body.clientOrderId || req.body.internalOrderId || "").trim();
    if (!requestedClientOrderId) {
      const missing = new Error("A stable OMS client order ID is required for idempotent broker submission.");
      missing.statusCode = 400;
      missing.code = "CLIENT_ORDER_ID_REQUIRED";
      throw missing;
    }
    const { data: existingOrder, error: existingOrderError } = await supabase
      .from("execution_orders")
      .select("*")
      .eq("user_id", user.id)
      .eq("account_id", account.id)
      .eq("client_order_id", requestedClientOrderId)
      .maybeSingle();
    if (existingOrderError) throw existingOrderError;
    if (existingOrder) {
      res.setHeader("X-Black-Terminal-Idempotent-Replay", "true");
      setServerTiming(res, timings, routeStartedAt);
      return res.status(200).json({ order: existingOrder, idempotentReplay: true });
    }

    stageStartedAt = performance.now();
    const [riskResult, positionsResult] = await Promise.all([
      supabase.from("account_risk_controls").select("*").eq("account_id", account.id).single(),
      supabase.from("account_positions").select("margin,unrealized_pnl").eq("account_id", account.id)
    ]);
    const { data: riskControls, error: riskError } = riskResult;
    const { data: positions, error: positionsError } = positionsResult;
    timings.push(["account_state", performance.now() - stageStartedAt]);

    if (riskError) throw riskError;
    if (positionsError) throw positionsError;

    const accountExposureUsd = positions.reduce((sum, row) => sum + Number(row.margin || 0), 0);
    const dailyPnl = positions.reduce((sum, row) => sum + Number(row.unrealized_pnl || 0), 0);
    const risk = checkOrderRisk({
      account,
      riskControls,
      order: req.body,
      accountExposureUsd,
      dailyPnl
    });
    const estimatedFees = risk.notional * 0.0004;
    const estimatedMargin = req.body.marketKind === "spot"
      ? risk.notional
      : risk.notional / Math.max(1, Number(req.body.leverage || 1));
    let status = "rejected";
    let rejectionReason = risk.reasons.join(" ");
    let exchangeOrderId = null;
    let clientOrderId = requestedClientOrderId;
    let mainnetValidationRecordId = null;

    const reservationResult = await supabase
      .from("execution_orders")
      .insert({
        user_id: user.id,
        account_id: account.id,
        exchange: account.exchange,
        symbol: String(req.body.symbol).toUpperCase(),
        side: req.body.side,
        order_type: req.body.orderType,
        quantity: Number(req.body.quantity),
        quantity_mode: req.body.quantityMode || req.body.sizingMethod || "quantity",
        limit_price: req.body.limitPrice ?? null,
        stop_price: req.body.stopPrice ?? null,
        take_profit: req.body.takeProfit ?? null,
        stop_loss: req.body.stopLoss ?? null,
        post_only: Boolean(req.body.postOnly),
        reduce_only: Boolean(req.body.reduceOnly),
        time_in_force: req.body.timeInForce || "gtc",
        status: risk.status === "approved" ? "pending" : "rejected",
        client_order_id: requestedClientOrderId,
        filled_quantity: 0,
        rejection_reason: risk.status === "approved" ? null : rejectionReason,
        estimated_fees: estimatedFees,
        estimated_margin: estimatedMargin,
        estimated_slippage: risk.notional * 0.0003,
        risk_check_status: risk.status,
        risk_check_reasons: risk.reasons
      })
      .select("*")
      .single();
    if (reservationResult.error) {
      if (reservationResult.error.code === "23505") {
        const { data: replay } = await supabase.from("execution_orders").select("*").eq("user_id", user.id).eq("account_id", account.id).eq("client_order_id", requestedClientOrderId).single();
        if (replay) {
          res.setHeader("X-Black-Terminal-Idempotent-Replay", "true");
          setServerTiming(res, timings, routeStartedAt);
          return res.status(200).json({ order: replay, idempotentReplay: true });
        }
      }
      throw reservationResult.error;
    }
    const reservedOrder = reservationResult.data;

    if (risk.status === "approved") {
      let credentials = null;
      try {
        stageStartedAt = performance.now();
        const { data: credential, error: credentialError } = await supabase
          .from("exchange_credentials")
          .select("encrypted_payload")
          .eq("account_id", account.id)
          .single();

        if (credentialError || !credential) throw credentialError || new Error("Missing encrypted credentials.");
        credentials = decryptCredentialPayload(credential.encrypted_payload);
        const adapter = createCloudExchangeAdapter(account.exchange, {
          credentials,
          network: account.network || account.environment,
          executionEnvironment: account.execution_environment || account.network || account.environment,
          endpointProfile: account.endpoint_profile || "GLOBAL",
          connectionId: account.id
        });
        const venueOrderDraft = {
          ...req.body,
          marketKind: req.body.marketKind || "perpetual",
          limitPrice: req.body.limitPrice,
          timeInForce: req.body.timeInForce || "gtc"
        };
        const [venueValidation, walletSnapshot] = await Promise.all([
          adapter.validateOrderDraft(venueOrderDraft),
          adapter.getWalletSnapshot()
        ]);
        timings.push(["venue_prepare", performance.now() - stageStartedAt]);
        const leverage = Math.max(1, Number(req.body.leverage || 1));
        const requiredMargin = req.body.marketKind === "spot" ? risk.notional : risk.notional / leverage;
        const requiredCollateral = requiredMargin + estimatedFees;
        if (!req.body.reduceOnly && requiredCollateral > walletSnapshot.accountMetrics.availableBalanceUsd) {
          const balanceError = new Error(`Order requires approximately ${requiredCollateral.toFixed(2)} USD collateral, but the venue reports ${walletSnapshot.accountMetrics.availableBalanceUsd.toFixed(2)} USD available.`);
          balanceError.statusCode = 403;
          balanceError.code = "INSUFFICIENT_BALANCE";
          throw balanceError;
        }
        const mainnetGate = adapter.validateProductionGate({
          account,
          order: req.body,
          risk,
          validation: venueValidation
        });
        mainnetValidationRecordId = await recordBybitValidationAttempt(supabase, user.id, account, req.body, {
          status: mainnetGate.ok ? "started" : "blocked",
          stage: "pre_order_gate",
          risk,
          maxNotionalUsd: mainnetGate.maxNotionalUsd,
          failureReason: mainnetGate.ok ? null : mainnetGate.reasons.join(" "),
          venueValidation
        });
        if (!mainnetGate.ok) {
          const validationError = new Error(mainnetGate.reasons.join(" "));
          validationError.statusCode = 403;
          validationError.code = "EXECUTION_BLOCKED";
          throw validationError;
        }
        const normalizedVenueOrder = {
          ...venueOrderDraft,
          quantity: venueValidation.normalized.quantity,
          quantityMode: "quantity",
          sizingMethod: "quantity",
          marketKind: req.body.marketKind || "perpetual",
          limitPrice: req.body.limitPrice,
          timeInForce: req.body.timeInForce || "gtc",
          source: req.body.source || "order-ticket",
          destinations: req.body.destinations || ["personal-portfolio"],
          clientOrderId: requestedClientOrderId,
          internalOrderId: requestedClientOrderId
        };
        const strategyOrder = ["chase-limit", "twap", "iceberg", "pov"].includes(req.body.orderType);
        stageStartedAt = performance.now();
        const exchangeResult = strategyOrder
          ? await adapter.placeStrategyOrder(normalizedVenueOrder, venueValidation)
          : await adapter.placeOrder(normalizedVenueOrder, venueValidation);
        timings.push(["venue_submit", performance.now() - stageStartedAt]);
        status = "accepted";
        rejectionReason = null;
        exchangeOrderId = exchangeResult.exchangeOrderId || null;
        clientOrderId = exchangeResult.clientOrderId || requestedClientOrderId;
        await completeBybitValidationAttempt(supabase, mainnetValidationRecordId, {
          status: "passed",
          exchangeOrderId,
          metadata: { exchangeResult }
        });
      } catch (exchangeError) {
        const uncertain = ["NETWORK_TIMEOUT", "BROKER_UNAVAILABLE", "RATE_LIMITED"].includes(String(exchangeError?.code || "")) || Number(exchangeError?.statusCode) === 504;
        let reconciled = null;
        if (uncertain && requestedClientOrderId && credentials) {
          try {
            const adapter = createCloudExchangeAdapter(account.exchange, {
              credentials,
              network: account.network || account.environment,
              executionEnvironment: account.execution_environment || account.network || account.environment,
              endpointProfile: account.endpoint_profile || "GLOBAL",
              connectionId: account.id
            });
            reconciled = await adapter.findOrderByClientOrderId({
              marketKind: req.body.marketKind || "perpetual",
              symbol: req.body.symbol,
              clientOrderId: requestedClientOrderId
            });
          } catch {
            // The response remains unknown and is deliberately not resubmitted.
          }
        }
        if (reconciled) {
          status = "accepted";
          rejectionReason = null;
          exchangeOrderId = reconciled.orderId || reconciled.venueOrderId || null;
        } else {
          status = uncertain ? "pending" : "rejected";
          rejectionReason = uncertain
            ? "[SUBMISSION_OUTCOME_UNKNOWN] Broker submission outcome is unknown. Automatic resubmission is blocked until order reconciliation completes."
            : `[${exchangeError?.code || "ORDER_REJECTED"}] ${exchangeError instanceof Error ? exchangeError.message : String(exchangeError)}`;
        }
        await completeBybitValidationAttempt(supabase, mainnetValidationRecordId, {
          status: uncertain ? "failed" : exchangeError?.statusCode === 403 ? "blocked" : "failed",
          failureReason: rejectionReason
        });
      }
    }

    stageStartedAt = performance.now();
    const { data: order, error: orderError } = await supabase
      .from("execution_orders")
      .update({
        status,
        exchange_order_id: exchangeOrderId,
        client_order_id: clientOrderId,
        rejection_reason: rejectionReason,
        updated_at: new Date().toISOString()
      })
      .eq("id", reservedOrder.id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (orderError) throw orderError;
    timings.push(["persist_order", performance.now() - stageStartedAt]);

    stageStartedAt = performance.now();
    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: account.id,
      order_id: order.id,
      event_type: status === "accepted" ? "order_accepted" : "order_rejected",
      severity: status === "accepted" ? "info" : risk.status === "approved" ? "warning" : "error",
      message: rejectionReason || `Order accepted by ${account.exchange}.`,
      metadata: {
        riskStatus: risk.status,
        notional: risk.notional,
        mainnetValidationRecordId,
        source: req.body.source || "order-ticket",
        destinations: req.body.destinations || ["personal-portfolio"],
        sizingMethod: req.body.sizingMethod || req.body.quantityMode || "quantity",
        leverage: req.body.leverage ?? null,
        marginMode: req.body.marginMode ?? null,
        strategyType: ["chase-limit", "twap", "iceberg", "pov"].includes(req.body.orderType) ? req.body.orderType : null,
        strategyParameters: req.body.strategyParameters || null
      }
    });
    timings.push(["audit", performance.now() - stageStartedAt]);

    setServerTiming(res, timings, routeStartedAt);
    return res.status(200).json({ order });
  } catch (error) {
    setServerTiming(res, timings, routeStartedAt);
    return sendError(res, error);
  }
}

function setServerTiming(res, timings, routeStartedAt) {
  const total = performance.now() - routeStartedAt;
  const values = [...timings, ["total", total]]
    .map(([name, duration]) => `${name};dur=${Number(duration).toFixed(1)}`)
    .join(", ");
  res.setHeader("Server-Timing", values);
  res.setHeader("X-Black-Terminal-Route-Ms", total.toFixed(1));
}

async function recordBybitValidationAttempt(supabase, userId, account, order, payload) {
  const requestedNotional = Number(order.quantity || 0) * Number(order.referencePrice || order.limitPrice || order.stopPrice || 0);
  const { data, error } = await supabase
    .from("mainnet_validation_records")
    .insert({
      user_id: userId,
      account_id: account.id,
      venue_id: "bybit",
      network: "mainnet",
      symbol: String(order.symbol || "").toUpperCase(),
      max_notional_usd: payload.maxNotionalUsd || null,
      requested_notional_usd: Math.abs(requestedNotional) || payload.risk?.notional || null,
      validation_stage: payload.stage,
      status: payload.status,
      live_confirmation: order.liveConfirmation || "required",
      risk_check_status: payload.risk?.status || null,
      failure_reason: payload.failureReason,
      metadata: {
        venueValidation: payload.venueValidation,
        orderType: order.orderType,
        marketKind: order.marketKind || "perpetual",
        timeInForce: order.timeInForce || "gtc"
      }
    })
    .select("id")
    .single();

  if (error) {
    await settleSupabaseQuery(supabase.from("execution_audit_logs").insert({
      user_id: userId,
      account_id: account.id,
      event_type: "mainnet_validation_record_failed",
      severity: "warning",
      message: error.message,
      metadata: { venueId: "bybit", symbol: order.symbol }
    }));
    return null;
  }

  return data?.id || null;
}

async function completeBybitValidationAttempt(supabase, recordId, payload) {
  if (!recordId) return;
  await settleSupabaseQuery(supabase
    .from("mainnet_validation_records")
    .update({
      status: payload.status,
      exchange_order_id: payload.exchangeOrderId || null,
      failure_reason: payload.failureReason || null,
      metadata: payload.metadata || {},
      completed_at: new Date().toISOString()
    })
    .eq("id", recordId));
}
