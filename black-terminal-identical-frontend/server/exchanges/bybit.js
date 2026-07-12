import crypto from "node:crypto";
import { getBybitPrivateStreamRuntimeDiagnostics } from "./bybit-private-stream.js";

const BYBIT_BASE_URL = process.env.BYBIT_BASE_URL || "https://api.bybit.com";
const RECV_WINDOW = "5000";
const BYBIT_MAINNET_LIVE_CONFIRMATION = "LIVE";
const BYBIT_ORDER_STATUS_TO_EXECUTION_STATUS = {
  created: "submitted",
  new: "working",
  partiallyfilled: "partially-filled",
  filled: "filled",
  cancelled: "cancelled",
  canceled: "cancelled",
  rejected: "rejected",
  deactivated: "cancelled",
  untriggered: "working",
  triggered: "working"
};

export async function validateBybitCredentials(credentials) {
  const startedAt = Date.now();
  const diagnostics = await getBybitDiagnostics(credentials, { symbol: "BTCUSDT" });
  const failedRequiredChecks = (diagnostics.checks || []).filter((check) => check.required && check.status === "failed");

  if (failedRequiredChecks.length > 0) {
    const message = failedRequiredChecks.map((check) => check.message).join(" ");
    const error = new Error(`Bybit credential validation failed. ${message}`);
    error.statusCode = failedRequiredChecks.some((check) => check.statusCode === 401 || isBybitAuthFailure(check.bybitCode, check.message)) ? 401 : 502;
    error.code = "BYBIT_CREDENTIAL_VALIDATION_FAILED";
    error.publicDetails = {
      failedChecks: failedRequiredChecks.map((check) => ({
        name: check.name,
        bybitCode: check.bybitCode,
        message: check.message
      }))
    };
    throw error;
  }

  return {
    status: "connected",
    apiHealth: "healthy",
    latencyMs: Date.now() - startedAt,
    diagnostics
  };
}

export async function getBybitServerTime() {
  const response = await bybitPublicRequest("/v5/market/time");
  const serverTimeMs = Number(response?.timeNano ? Math.floor(Number(response.timeNano) / 1_000_000) : response?.timeSecond ? Number(response.timeSecond) * 1000 : Date.now());
  return {
    serverTimeMs,
    serverTime: new Date(serverTimeMs).toISOString(),
    localTimeMs: Date.now(),
    clockSkewMs: Date.now() - serverTimeMs
  };
}

export async function getBybitInstrumentMetadata({ category = "linear", symbol = "BTCUSDT" } = {}) {
  const response = await bybitPublicRequest("/v5/market/instruments-info", { category, symbol });
  const list = response?.list || [];
  return list.map((instrument) => ({
    venueId: "bybit",
    nativeSymbol: instrument.symbol,
    canonicalBase: instrument.baseCoin || symbol.replace(/USDT$/, ""),
    canonicalQuote: instrument.quoteCoin || "USDT",
    settlementAsset: instrument.settleCoin || instrument.quoteCoin || "USDT",
    marketType: category === "spot" ? "spot" : "perpetual",
    contractType: instrument.contractType || null,
    expiry: instrument.deliveryTime ? new Date(Number(instrument.deliveryTime)).toISOString() : null,
    contractMultiplier: nullableNumber(instrument.lotSizeFilter?.qtyStep) || 1,
    tickSize: nullableNumber(instrument.priceFilter?.tickSize),
    quantityStep: nullableNumber(instrument.lotSizeFilter?.qtyStep),
    minQuantity: nullableNumber(instrument.lotSizeFilter?.minOrderQty),
    minNotional: nullableNumber(instrument.lotSizeFilter?.minNotionalValue),
    maxQuantity: nullableNumber(instrument.lotSizeFilter?.maxOrderQty),
    pricePrecision: precisionFromStep(instrument.priceFilter?.tickSize),
    quantityPrecision: precisionFromStep(instrument.lotSizeFilter?.qtyStep),
    leverageLimits: {
      min: nullableNumber(instrument.leverageFilter?.minLeverage),
      max: nullableNumber(instrument.leverageFilter?.maxLeverage),
      step: nullableNumber(instrument.leverageFilter?.leverageStep)
    },
    supportedMarginModes: category === "spot" ? [] : ["cross", "isolated"],
    supportedTimeInForce: ["GTC", "IOC", "FOK", "PostOnly"],
    supportedTriggerBehavior: { triggerOrders: category !== "spot", takeProfitStopLoss: category !== "spot" },
    tradingStatus: instrument.status || "unknown",
    raw: instrument
  }));
}

export async function getBybitOpenOrders(credentials, { category = "linear", symbol } = {}) {
  const response = await bybitRequest(credentials, "GET", "/v5/order/realtime", {
    category,
    symbol,
    limit: "50",
    openOnly: "0"
  });
  return (response?.list || []).map((order) => ({
    orderId: order.orderId,
    clientOrderId: order.orderLinkId,
    symbol: order.symbol,
    side: String(order.side || "").toLowerCase() === "sell" ? "sell" : "buy",
    type: String(order.orderType || "").toLowerCase(),
    status: normalizeBybitOrderStatus(order.orderStatus),
    quantity: Number(order.qty || 0),
    filledQuantity: Number(order.cumExecQty || 0),
    averageFillPrice: nullableNumber(order.avgPrice),
    price: nullableNumber(order.price),
    reduceOnly: Boolean(order.reduceOnly),
    timeInForce: order.timeInForce,
    updatedAt: Number(order.updatedTime || Date.now())
  }));
}

export async function getBybitDiagnostics(credentials, { symbol = "BTCUSDT" } = {}) {
  const startedAt = Date.now();
  const checks = await Promise.all([
    runBybitDiagnosticCheck("server-time", () => getBybitServerTime(), true),
    runBybitDiagnosticCheck("instrument-metadata", () => getBybitInstrumentMetadata({ category: "linear", symbol }), true),
    runBybitDiagnosticCheck("balances", () => getBybitBalances(credentials), true),
    runBybitDiagnosticCheck("positions", () => getBybitPositions(credentials), true),
    runBybitDiagnosticCheck("open-orders", () => getBybitOpenOrders(credentials, { category: "linear", symbol }), false),
    runBybitDiagnosticCheck("api-key-permissions", () => getBybitApiKeyInformation(credentials), false)
  ]);
  const requiredFailures = checks.filter((check) => check.required && check.status === "failed");
  const time = diagnosticData(checks, "server-time", {
    serverTimeMs: Date.now(),
    serverTime: new Date().toISOString(),
    localTimeMs: Date.now(),
    clockSkewMs: 0
  });
  const metadata = diagnosticData(checks, "instrument-metadata", []);
  const balances = diagnosticData(checks, "balances", []);
  const positions = diagnosticData(checks, "positions", []);
  const openOrders = diagnosticData(checks, "open-orders", []);
  const apiKeyInfo = diagnosticData(checks, "api-key-permissions", {
    readOnly: true,
    permissions: {},
    error: checks.find((check) => check.name === "api-key-permissions")?.message || "Bybit API-key permission probe did not complete."
  });
  const permissionReport = normalizeBybitPermissionReport(apiKeyInfo);
  const privateStreamRuntime = getBybitPrivateStreamRuntimeDiagnostics();
  const privateStreamsReady = privateStreamRuntime.status === "connected" && privateStreamRuntime.authenticated === true;
  const mainnetValidationEnabled = process.env.BYBIT_MAINNET_VALIDATION_ENABLED === "true";
  const accountReadReady = requiredFailures.length === 0;
  const executionReady = Boolean(accountReadReady && mainnetValidationEnabled && permissionReport.trading && privateStreamsReady);
  const readinessReason = executionReady
    ? "Bybit execution readiness checks passed for controlled mainnet validation."
    : [
        !accountReadReady ? `Bybit account read validation failed: ${requiredFailures.map((check) => check.message).join(" ")}` : "",
        !mainnetValidationEnabled ? "BYBIT_MAINNET_VALIDATION_ENABLED is not true." : "",
        !permissionReport.trading ? "Bybit API key is read-only or lacks order/position trading permission." : "",
        !privateStreamsReady ? "Bybit private stream runtime is not authenticated and connected." : ""
      ].filter(Boolean).join(" ");

  return {
    venueId: "bybit",
    provider: "bybit",
    network: "mainnet",
    executionMode: executionReady ? "full-live" : "read-only",
    readiness: executionReady ? "execution-ready" : "execution-blocked",
    latencyMs: Date.now() - startedAt,
    authentication: "authenticated",
    synchronization: accountReadReady ? "snapshot-synced" : "failed",
    publicStream: "connected",
    privateStream: privateStreamRuntime.status,
    checks: checks.map(({ data, ...check }) => check),
    permissions: {
      read: accountReadReady,
      trading: permissionReport.trading,
      withdrawal: permissionReport.withdrawal,
      warnings: [
        ...permissionReport.warnings,
        executionReady ? "" : readinessReason,
        "Bybit is not production-certified until market, limit, cancel, modify, close, TP/SL, reconnect reconciliation, and recorded mainnet validation all pass."
      ].filter(Boolean)
    },
    readinessReason,
    time,
    metadata,
    balances,
    positions,
    openOrders,
    apiKeyInfo,
    privateStreamRuntime,
    endpoints: {
      order: permissionReport.trading ? "available-gated" : "blocked-permission",
      cancel: permissionReport.trading ? "available-gated" : "blocked-permission",
      modify: permissionReport.trading ? "available-gated" : "blocked-permission",
      positionProtection: permissionReport.trading ? "available-gated" : "blocked-permission"
    },
    rateLimitUsage: "unknown",
    certification: {
      marketDataReady: true,
      authReady: true,
      accountReadReady,
      balancesReady: checks.find((check) => check.name === "balances")?.status === "ok",
      positionsReady: checks.find((check) => check.name === "positions")?.status === "ok",
      openOrdersReady: checks.find((check) => check.name === "open-orders")?.status === "ok",
      fillsReady: privateStreamsReady,
      privateStreamsReady,
      orderEndpointReady: permissionReport.trading,
      cancelEndpointReady: permissionReport.trading,
      modifyEndpointReady: permissionReport.trading,
      metadataFresh: metadata.length > 0,
      executionReady,
      mainnetValidated: false,
      certificationStatus: executionReady ? "validation-ready" : "blocked",
      readinessReason
    }
  };
}

export async function syncBybitAccountToSupabase(supabase, account, credentials) {
  const [balances, positions] = await Promise.all([
    getBybitBalances(credentials),
    getBybitPositions(credentials)
  ]);

  if (balances.length > 0) {
    const { error } = await supabase
      .from("account_balances")
      .upsert(
        balances.map((balance) => ({
          account_id: account.id,
          asset: balance.asset,
          free: balance.free,
          locked: balance.locked,
          total: balance.total,
          usd_value: balance.usdValue,
          updated_at: new Date().toISOString()
        })),
        { onConflict: "account_id,asset" }
      );

    if (error) throw error;
  }

  if (positions.length > 0) {
    const { error } = await supabase
      .from("account_positions")
      .upsert(
        positions.map((position) => ({
          account_id: account.id,
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
        })),
        { onConflict: "account_id,symbol,direction" }
      );

    if (error) throw error;
  }

  const equityUsd = balances.reduce((sum, balance) => sum + balance.usdValue, 0);
  const marginUsed = positions.reduce((sum, position) => sum + position.margin, 0);

  await supabase
    .from("exchange_accounts")
    .update({
      status: "connected",
      api_health: "healthy",
      latency_ms: 0
    })
    .eq("id", account.id);

  return {
    balances,
    positions,
    equityUsd,
    marginUsed
  };
}

export async function placeBybitOrder(credentials, order) {
  const validation = await validateBybitOrderDraft(credentials, order);
  if (!validation.ok) {
    const error = new Error(validation.reasons.join(" "));
    error.statusCode = 400;
    error.validation = validation;
    throw error;
  }

  const category = order.marketKind === "spot" ? "spot" : "linear";
  const orderType = normalizeBybitOrderType(order.orderType);
  const body = {
    category,
    symbol: order.symbol,
    side: order.side === "buy" ? "Buy" : "Sell",
    orderType,
    qty: formatBybitNumber(order.quantity, validation.metadata?.quantityPrecision),
    timeInForce: normalizeBybitTimeInForce(order.timeInForce, order),
    orderLinkId: order.clientOrderId || order.internalOrderId || createBybitClientOrderId()
  };

  if (orderType === "Limit" && order.limitPrice) {
    body.price = formatBybitNumber(order.limitPrice, validation.metadata?.pricePrecision);
  }

  if (order.stopPrice) {
    body.triggerPrice = formatBybitNumber(order.stopPrice, validation.metadata?.pricePrecision);
    body.triggerDirection = Number(order.stopPrice) >= Number(order.referencePrice || order.limitPrice || 0) ? 1 : 2;
  }

  if (order.takeProfit) {
    body.takeProfit = formatBybitNumber(order.takeProfit, validation.metadata?.pricePrecision);
  }

  if (order.stopLoss) {
    body.stopLoss = formatBybitNumber(order.stopLoss, validation.metadata?.pricePrecision);
  }

  if (category !== "spot" && order.reduceOnly) {
    body.reduceOnly = true;
  }

  if (category !== "spot" && order.leverage) {
    await setBybitLeverage(credentials, {
      category,
      symbol: order.symbol,
      leverage: order.leverage
    });
  }

  const response = await bybitRequest(credentials, "POST", "/v5/order/create", {}, body);
  return normalizeBybitExecutionReport({
    accountId: order.accountId,
    exchange: "bybit",
    symbol: order.symbol,
    status: "accepted",
    orderId: response?.orderId,
    clientOrderId: response?.orderLinkId || body.orderLinkId,
    filledQuantity: 0,
    raw: response
  });
}

export async function cancelBybitOrder(credentials, { marketKind = "perpetual", symbol, orderId, clientOrderId }) {
  if (!orderId && !clientOrderId) throw new Error("Bybit cancel requires orderId or clientOrderId.");
  const category = marketKind === "spot" ? "spot" : "linear";
  const response = await bybitRequest(credentials, "POST", "/v5/order/cancel", {}, {
    category,
    symbol,
    orderId,
    orderLinkId: clientOrderId
  });
  return normalizeBybitExecutionReport({
    exchange: "bybit",
    symbol,
    status: "cancelled",
    exchangeOrderId: response?.orderId,
    orderId: response?.orderId || orderId,
    clientOrderId: response?.orderLinkId || clientOrderId,
    filledQuantity: 0,
    raw: response
  });
}

export async function cancelAllBybitOrders(credentials, { marketKind = "perpetual", symbol } = {}) {
  const category = marketKind === "spot" ? "spot" : "linear";
  const response = await bybitRequest(credentials, "POST", "/v5/order/cancel-all", {}, {
    category,
    symbol
  });
  return {
    status: "accepted",
    symbol,
    cancelled: response?.list || [],
    raw: response
  };
}

export async function modifyBybitOrder(credentials, patch) {
  if (!patch.orderId && !patch.clientOrderId) throw new Error("Bybit modify requires orderId or clientOrderId.");
  const category = patch.marketKind === "spot" ? "spot" : "linear";
  const body = {
    category,
    symbol: patch.symbol,
    orderId: patch.orderId,
    orderLinkId: patch.clientOrderId,
    qty: patch.quantity ? String(patch.quantity) : undefined,
    price: patch.limitPrice ? String(patch.limitPrice) : undefined,
    triggerPrice: patch.stopPrice ? String(patch.stopPrice) : undefined,
    takeProfit: patch.takeProfit ? String(patch.takeProfit) : undefined,
    stopLoss: patch.stopLoss ? String(patch.stopLoss) : undefined
  };
  const response = await bybitRequest(credentials, "POST", "/v5/order/amend", {}, body);
  return normalizeBybitExecutionReport({
    exchange: "bybit",
    symbol: patch.symbol,
    status: "working",
    orderId: response?.orderId || patch.orderId,
    clientOrderId: response?.orderLinkId || patch.clientOrderId
  });
}

export async function closeBybitPosition(credentials, { marketKind = "perpetual", symbol, direction, quantity, positionIdx, clientOrderId }) {
  if (!symbol) throw new Error("Bybit close position requires a symbol.");
  const side = direction === "short" || direction === "sell" ? "Buy" : "Sell";
  const response = await bybitRequest(credentials, "POST", "/v5/order/create", {}, {
    category: marketKind === "spot" ? "spot" : "linear",
    symbol,
    side,
    orderType: "Market",
    qty: String(quantity || 0),
    reduceOnly: true,
    orderLinkId: clientOrderId || createBybitClientOrderId("bt-close"),
    positionIdx
  });
  return normalizeBybitExecutionReport({
    exchange: "bybit",
    symbol,
    status: "accepted",
    orderId: response?.orderId,
    clientOrderId: response?.orderLinkId,
    filledQuantity: 0,
    raw: response
  });
}

export async function reverseBybitPosition(credentials, { marketKind = "perpetual", symbol, direction, quantity, clientOrderId }) {
  const closeReport = await closeBybitPosition(credentials, {
    marketKind,
    symbol,
    direction,
    quantity,
    clientOrderId: clientOrderId ? `${clientOrderId}-close` : undefined
  });
  const openSide = direction === "short" || direction === "sell" ? "buy" : "sell";
  const openReport = await placeBybitOrder(credentials, {
    marketKind,
    symbol,
    side: openSide,
    orderType: "market",
    quantity,
    clientOrderId: clientOrderId ? `${clientOrderId}-reverse` : undefined,
    reduceOnly: false
  });
  return {
    status: openReport.status,
    closeReport,
    openReport,
    orderId: openReport.orderId,
    clientOrderId: openReport.clientOrderId
  };
}

export async function setBybitPositionProtection(credentials, patch) {
  const category = patch.marketKind === "spot" ? "spot" : "linear";
  if (category === "spot") throw new Error("Bybit spot does not support native futures TP/SL protection.");
  const body = {
    category,
    symbol: patch.symbol,
    tpslMode: patch.tpslMode || "Full",
    positionIdx: patch.positionIdx,
    takeProfit: patch.takeProfit !== undefined ? String(patch.takeProfit || 0) : undefined,
    stopLoss: patch.stopLoss !== undefined ? String(patch.stopLoss || 0) : undefined,
    trailingStop: patch.trailingStop !== undefined ? String(patch.trailingStop || 0) : undefined,
    activePrice: patch.trailingActivationPrice !== undefined ? String(patch.trailingActivationPrice || 0) : undefined,
    tpTriggerBy: patch.tpTriggerBy || "LastPrice",
    slTriggerBy: patch.slTriggerBy || "LastPrice"
  };
  const response = await bybitRequest(credentials, "POST", "/v5/position/trading-stop", {}, body);
  return {
    status: "accepted",
    protectionMode: "native",
    symbol: patch.symbol,
    takeProfit: patch.takeProfit ?? null,
    stopLoss: patch.stopLoss ?? null,
    trailingStop: patch.trailingStop ?? null,
    raw: response
  };
}

export async function setBybitLeverage(credentials, { category = "linear", symbol, leverage, buyLeverage, sellLeverage }) {
  if (!symbol) throw new Error("Bybit leverage update requires a symbol.");
  if (!leverage && !buyLeverage && !sellLeverage) throw new Error("Bybit leverage update requires leverage.");
  const nextBuyLeverage = String(buyLeverage || leverage);
  const nextSellLeverage = String(sellLeverage || leverage);
  const response = await bybitRequest(credentials, "POST", "/v5/position/set-leverage", {}, {
    category,
    symbol,
    buyLeverage: nextBuyLeverage,
    sellLeverage: nextSellLeverage
  });
  return {
    status: "accepted",
    symbol,
    buyLeverage: Number(nextBuyLeverage),
    sellLeverage: Number(nextSellLeverage),
    raw: response
  };
}

export async function switchBybitMarginMode(credentials, { category = "linear", symbol, marginMode, leverage, buyLeverage, sellLeverage }) {
  if (!symbol) throw new Error("Bybit margin-mode update requires a symbol.");
  if (!["cross", "isolated"].includes(marginMode)) throw new Error("Bybit margin mode must be cross or isolated.");
  const nextLeverage = leverage || buyLeverage || sellLeverage;
  if (!nextLeverage) throw new Error("Bybit margin-mode switch requires explicit leverage.");
  const response = await bybitRequest(credentials, "POST", "/v5/position/switch-isolated", {}, {
    category,
    symbol,
    tradeMode: marginMode === "cross" ? 0 : 1,
    buyLeverage: String(buyLeverage || nextLeverage),
    sellLeverage: String(sellLeverage || nextLeverage)
  });
  return {
    status: "accepted",
    symbol,
    marginMode,
    buyLeverage: Number(buyLeverage || nextLeverage),
    sellLeverage: Number(sellLeverage || nextLeverage),
    raw: response
  };
}

export async function switchBybitPositionMode(credentials, { category = "linear", symbol, settleCoin, positionMode }) {
  if (!["one-way", "hedge"].includes(positionMode)) throw new Error("Bybit position mode must be one-way or hedge.");
  if (!symbol && !settleCoin) throw new Error("Bybit position-mode switch requires symbol or settleCoin.");
  const response = await bybitRequest(credentials, "POST", "/v5/position/switch-mode", {}, {
    category,
    symbol,
    coin: settleCoin,
    mode: positionMode === "hedge" ? 3 : 0
  });
  return {
    status: "accepted",
    symbol,
    settleCoin,
    positionMode,
    raw: response
  };
}

export async function validateBybitOrderDraft(credentials, order) {
  const category = order.marketKind === "spot" ? "spot" : "linear";
  const symbol = normalizeBybitSymbol(order.symbol);
  const metadata = (await getBybitInstrumentMetadata({ category, symbol }))[0];
  return evaluateBybitOrderDraftAgainstMetadata(metadata, order, { category, symbol });
}

export function evaluateBybitOrderDraftAgainstMetadata(metadata, order, context = {}) {
  const category = context.category || (order.marketKind === "spot" ? "spot" : "linear");
  const symbol = context.symbol || normalizeBybitSymbol(order.symbol);
  const reasons = [];
  const quantity = Number(order.quantity || 0);
  const referencePrice = Number(order.referencePrice || order.limitPrice || order.stopPrice || 0);
  const notional = Math.abs(quantity * referencePrice);
  const orderType = normalizeBybitOrderType(order.orderType);

  if (!metadata) reasons.push(`Bybit metadata is unavailable for ${symbol}.`);
  if (metadata?.tradingStatus && !["Trading", "trading"].includes(String(metadata.tradingStatus))) {
    reasons.push(`${symbol} is not trading on Bybit (${metadata.tradingStatus}).`);
  }
  if (!quantity || quantity <= 0) reasons.push("Quantity must be greater than zero.");
  if (metadata?.minQuantity && quantity < metadata.minQuantity) {
    reasons.push(`Quantity is below Bybit minimum ${metadata.minQuantity}.`);
  }
  if (metadata?.maxQuantity && quantity > metadata.maxQuantity) {
    reasons.push(`Quantity exceeds Bybit maximum ${metadata.maxQuantity}.`);
  }
  if (metadata?.quantityStep && !isStepAligned(quantity, metadata.quantityStep)) {
    reasons.push(`Quantity must align to Bybit quantity step ${metadata.quantityStep}.`);
  }
  if (orderType === "Limit") {
    if (!order.limitPrice || Number(order.limitPrice) <= 0) reasons.push("Limit order requires a positive limit price.");
    if (metadata?.tickSize && order.limitPrice && !isStepAligned(Number(order.limitPrice), metadata.tickSize)) {
      reasons.push(`Limit price must align to Bybit tick size ${metadata.tickSize}.`);
    }
  }
  if (order.stopPrice && metadata?.tickSize && !isStepAligned(Number(order.stopPrice), metadata.tickSize)) {
    reasons.push(`Stop price must align to Bybit tick size ${metadata.tickSize}.`);
  }
  if (metadata?.minNotional && referencePrice > 0 && notional < metadata.minNotional) {
    reasons.push(`Order notional ${notional.toFixed(4)} is below Bybit minimum notional ${metadata.minNotional}.`);
  }
  if (category !== "spot" && order.leverage && metadata?.leverageLimits?.max && Number(order.leverage) > metadata.leverageLimits.max) {
    reasons.push(`Leverage exceeds Bybit maximum ${metadata.leverageLimits.max}x.`);
  }
  if (category !== "spot" && order.marginMode && !metadata?.supportedMarginModes?.includes(order.marginMode)) {
    reasons.push(`Margin mode ${order.marginMode} is not supported for ${symbol}.`);
  }
  if (order.postOnly && order.timeInForce && order.timeInForce !== "gtc") {
    reasons.push("Bybit post-only orders must use GTC/PostOnly behavior.");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    category,
    symbol,
    metadata,
    normalized: {
      orderType,
      timeInForce: normalizeBybitTimeInForce(order.timeInForce, order),
      quantity,
      referencePrice,
      notional
    }
  };
}

export function validateBybitMainnetValidationRequest({ account, order, risk, validation }) {
  const reasons = [];
  const allowedConnections = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS);
  const allowedSymbols = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase());
  const maxNotional = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0);

  if (process.env.BYBIT_MAINNET_VALIDATION_ENABLED !== "true") {
    reasons.push("BYBIT_MAINNET_VALIDATION_ENABLED must be true.");
  }
  if (order.mainnetConfirmed !== true || order.liveConfirmation !== BYBIT_MAINNET_LIVE_CONFIRMATION) {
    reasons.push(`Each Bybit mainnet validation order requires explicit per-order confirmation: ${BYBIT_MAINNET_LIVE_CONFIRMATION}.`);
  }
  if (!allowedConnections.length || !allowedConnections.includes(account.id)) {
    reasons.push("Bybit account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  }
  if (!allowedSymbols.length || !allowedSymbols.includes(String(order.symbol || "").toUpperCase())) {
    reasons.push("Bybit symbol is not in BYBIT_MAINNET_ALLOWED_SYMBOLS.");
  }
  if (!Number.isFinite(maxNotional) || maxNotional <= 0) {
    reasons.push("BYBIT_MAINNET_MAX_NOTIONAL_USD must be configured.");
  } else if (risk.notional > maxNotional) {
    reasons.push(`Order notional exceeds BYBIT_MAINNET_MAX_NOTIONAL_USD (${maxNotional}).`);
  }
  if (!validation?.ok) {
    reasons.push(...(validation?.reasons || ["Bybit venue validation failed."]));
  }

  return {
    ok: reasons.length === 0,
    reasons,
    maxNotionalUsd: maxNotional
  };
}

export function validateBybitManagementGate({ account, body, symbol }) {
  const reasons = [];
  const allowedConnections = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_CONNECTIONS);
  const allowedSymbols = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase());
  const nativeSymbol = String(symbol || body.symbol || "").toUpperCase();

  if (process.env.BYBIT_MAINNET_VALIDATION_ENABLED !== "true") {
    reasons.push("BYBIT_MAINNET_VALIDATION_ENABLED must be true.");
  }
  if (body.mainnetConfirmed !== true || body.liveConfirmation !== BYBIT_MAINNET_LIVE_CONFIRMATION) {
    reasons.push(`Bybit live management action requires explicit confirmation: ${BYBIT_MAINNET_LIVE_CONFIRMATION}.`);
  }
  if (!allowedConnections.length || !allowedConnections.includes(account.id)) {
    reasons.push("Bybit account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  }
  if (!allowedSymbols.length || !allowedSymbols.includes(nativeSymbol)) {
    reasons.push("Bybit symbol is not in BYBIT_MAINNET_ALLOWED_SYMBOLS.");
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

export async function getBybitBalances(credentials) {
  const response = await bybitRequest(credentials, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
  const account = response?.list?.[0];
  const coins = account?.coin || [];

  return coins
    .map((coin) => {
      const total = Number(coin.walletBalance || 0);
      const usdValue = Number(coin.usdValue || 0);
      const locked = Number(coin.locked || 0);
      const free = Math.max(0, total - locked);

      return {
        asset: coin.coin,
        free,
        locked,
        total,
        usdValue
      };
    })
    .filter((coin) => coin.total > 0 || coin.usdValue > 0);
}

export async function getBybitPositions(credentials) {
  const response = await bybitRequest(credentials, "GET", "/v5/position/list", {
    category: "linear",
    settleCoin: "USDT",
    limit: "200"
  });
  const rows = response?.list || [];

  return rows
    .map((position) => {
      const quantity = Number(position.size || 0);
      const direction = position.side === "Sell" ? "short" : position.side === "Buy" ? "long" : "flat";

      return {
        symbol: position.symbol,
        direction,
        quantity,
        averagePrice: Number(position.avgPrice || 0),
        currentPrice: Number(position.markPrice || 0),
        unrealizedPnl: Number(position.unrealisedPnl || 0),
        realizedPnl: Number(position.cumRealisedPnl || 0),
        margin: Number(position.positionIM || position.positionValue || 0),
        leverage: Number(position.leverage || 1),
        liquidationPrice: nullableNumber(position.liqPrice),
        stopLoss: nullableNumber(position.stopLoss),
        takeProfit: nullableNumber(position.takeProfit),
        openedAt: Number(position.createdTime || position.updatedTime || Date.now())
      };
    })
    .filter((position) => position.quantity > 0 && position.direction !== "flat");
}

async function bybitRequest(credentials, method, path, query = {}, body) {
  const timestamp = String(Date.now());
  const queryString = buildQueryString(query);
  const bodyString = body ? JSON.stringify(body) : "";
  const payload = method === "GET"
    ? `${timestamp}${credentials.apiKey}${RECV_WINDOW}${queryString}`
    : `${timestamp}${credentials.apiKey}${RECV_WINDOW}${bodyString}`;
  const signature = crypto.createHmac("sha256", credentials.apiSecret).update(payload).digest("hex");
  const url = `${BYBIT_BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW
    },
    body: method === "GET" ? undefined : bodyString
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || data?.retCode !== 0) {
    const bybitCode = data?.retCode;
    const bybitMessage = String(data?.retMsg || "").trim();
    const error = new Error(bybitMessage || `Bybit request failed${bybitCode !== undefined ? ` with retCode ${bybitCode}` : ""} at ${path} (HTTP ${response.status})`);
    error.statusCode = response.status === 401 ? 401 : 502;
    error.bybit = data;
    error.bybitEndpoint = path;
    throw error;
  }

  return data.result;
}

export async function getBybitApiKeyInformation(credentials) {
  return bybitRequest(credentials, "GET", "/v5/user/query-api", {});
}

async function bybitPublicRequest(path, query = {}) {
  const queryString = buildQueryString(query);
  const response = await fetch(`${BYBIT_BASE_URL}${path}${queryString ? `?${queryString}` : ""}`);
  const data = await response.json().catch(() => null);

  if (!response.ok || data?.retCode !== 0) {
    const error = new Error(data?.retMsg || `Bybit public request failed with HTTP ${response.status}`);
    error.statusCode = response.status === 404 ? 404 : 502;
    error.bybit = data;
    throw error;
  }

  return data.result;
}

function buildQueryString(query) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function runBybitDiagnosticCheck(name, fn, required) {
  const startedAt = Date.now();
  try {
    const data = await fn();
    return {
      name,
      required,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      data
    };
  } catch (error) {
    const message = formatBybitDiagnosticFailure(name, error);
    return {
      name,
      required,
      status: "failed",
      latencyMs: Date.now() - startedAt,
      message,
      statusCode: error?.statusCode || 502,
      bybitCode: error?.bybit?.retCode,
      endpoint: error?.bybitEndpoint || null
    };
  }
}

function diagnosticData(checks, name, fallback) {
  const check = checks.find((item) => item.name === name);
  return check?.status === "ok" ? check.data : fallback;
}

function formatBybitDiagnosticFailure(name, error) {
  const bybitCode = error?.bybit?.retCode;
  const baseMessage = String(error?.bybit?.retMsg || error?.message || "Unknown Bybit validation failure.").trim() || "Unknown Bybit validation failure.";
  const hint = bybitFailureHint(bybitCode, baseMessage);
  return `${name} failed${bybitCode !== undefined ? ` (Bybit ${bybitCode})` : ""}: ${baseMessage}${hint ? ` ${hint}` : ""}`;
}

function isBybitAuthFailure(code, message = "") {
  const text = String(message || "").toLowerCase();
  return [10003, 10004, 10005, 10006, 10007, 10010, 10016].includes(Number(code)) ||
    text.includes("api key") ||
    text.includes("signature") ||
    text.includes("permission") ||
    text.includes("ip");
}

function bybitFailureHint(code, message = "") {
  const numericCode = Number(code);
  const text = String(message || "").toLowerCase();

  if (numericCode === 10003 || text.includes("api key is invalid") || text.includes("apikey")) {
    return "Check that the key is a Bybit mainnet V5 system-generated HMAC key, not testnet or RSA/self-generated.";
  }
  if (numericCode === 10004 || text.includes("signature")) {
    return "Check that the API secret was copied exactly; extra spaces or the wrong key type will break HMAC signing.";
  }
  if (numericCode === 10005 || text.includes("permission")) {
    return "Enable read access for Unified wallet, contract/derivatives positions, and order reads.";
  }
  if (numericCode === 10010 || text.includes("ip")) {
    return "Your Bybit key appears IP restricted; allow Vercel outbound access or create an unrestricted validation key with withdrawals disabled.";
  }
  if (text.includes("recv_window") || text.includes("timestamp")) {
    return "The server clock or Bybit recv window check failed; retry after server-time sync.";
  }
  return "";
}

function normalizeBybitSymbol(symbol) {
  return String(symbol || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function normalizeBybitOrderType(orderType) {
  if (orderType === "market") return "Market";
  if (orderType === "stop-market") return "Market";
  if (["trailing-stop", "twap", "iceberg"].includes(orderType)) {
    throw new Error(`${orderType} execution algorithm is not configured for Bybit yet.`);
  }
  return "Limit";
}

export function normalizeBybitTimeInForce(timeInForce, order = {}) {
  if (order.postOnly || order.orderType === "post-only") return "PostOnly";
  if (timeInForce === "ioc") return "IOC";
  if (timeInForce === "fok") return "FOK";
  return "GTC";
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function precisionFromStep(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!text.includes(".")) return 0;
  return text.split(".")[1].replace(/0+$/, "").length;
}

export function normalizeBybitOrderStatus(status) {
  const value = String(status || "").replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (value.includes("partiallyfilled")) return "partially-filled";
  if (value.includes("filled")) return "filled";
  if (value.includes("cancel")) return "cancelled";
  if (value.includes("reject")) return "rejected";
  if (value.includes("expired")) return "expired";
  if (value.includes("new") || value.includes("created")) return "working";
  if (value.includes("untriggered") || value.includes("triggered")) return "working";
  return BYBIT_ORDER_STATUS_TO_EXECUTION_STATUS[value] || value || "pending";
}

export function normalizeBybitExecutionReport(report) {
  const status = normalizeExecutionStatus(report.status);
  const orderId = report.orderId || report.exchangeOrderId || report.raw?.orderId || "bybit-order";
  return {
    accountId: report.accountId,
    exchange: report.exchange || "bybit",
    orderId,
    exchangeOrderId: orderId,
    clientOrderId: report.clientOrderId || report.raw?.orderLinkId || undefined,
    symbol: report.symbol,
    status,
    filledQuantity: Number(report.filledQuantity || 0),
    averageFillPrice: nullableNumber(report.averageFillPrice),
    reason: report.reason || report.raw?.rejectReason || undefined,
    time: Number(report.time || Date.now()),
    raw: report.raw
  };
}

export function normalizeBybitPermissionReport(apiKeyInfo = {}) {
  const permissions = apiKeyInfo.permissions || {};
  const readOnly = apiKeyInfo.readOnly === 1 || apiKeyInfo.readOnly === "1" || apiKeyInfo.readOnly === true;
  const contract = normalizePermissionList(permissions.ContractTrade || permissions.contractTrade || permissions.Derivatives || []);
  const spot = normalizePermissionList(permissions.Spot || permissions.spot || []);
  const wallet = normalizePermissionList(permissions.Wallet || permissions.wallet || []);
  const trading = !readOnly && (
    contract.some((item) => ["order", "position", "trade"].includes(item)) ||
    spot.some((item) => ["spottrade", "trade"].includes(item))
  );
  const withdrawal = wallet.some((item) => ["withdraw", "withdrawal"].includes(item));
  const warnings = [];

  if (readOnly) warnings.push("Bybit API key is read-only.");
  if (!trading) warnings.push("Bybit API key does not advertise trading permission.");
  if (withdrawal) warnings.push("Withdrawal permission detected. Use trading-only API keys.");
  if (apiKeyInfo.error) warnings.push(`Bybit API-key permission probe failed: ${apiKeyInfo.error}`);

  return {
    read: true,
    trading,
    withdrawal,
    warnings,
    raw: apiKeyInfo
  };
}

function normalizePermissionList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").replace(/[^a-zA-Z]/g, "").toLowerCase());
}

function normalizeExecutionStatus(status) {
  const value = String(status || "").replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (value === "submitted") return "pending";
  if (value === "working") return "accepted";
  if (value === "partiallyfilled") return "partially-filled";
  if (["pending", "accepted", "partially-filled", "filled", "cancelled", "rejected", "expired"].includes(status)) return status;
  return BYBIT_ORDER_STATUS_TO_EXECUTION_STATUS[value] || "accepted";
}

function isStepAligned(value, step) {
  const numericValue = Number(value);
  const numericStep = Number(step);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericStep) || numericStep <= 0) return false;
  const quotient = numericValue / numericStep;
  return Math.abs(quotient - Math.round(quotient)) < 1e-8;
}

function formatBybitNumber(value, precision) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (typeof precision === "number" && precision >= 0) return numeric.toFixed(precision).replace(/\.?0+$/, "");
  return String(numeric);
}

function createBybitClientOrderId(prefix = "bt") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
