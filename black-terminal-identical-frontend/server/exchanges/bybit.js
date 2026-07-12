import crypto from "node:crypto";
import { getBybitPrivateStreamRuntimeDiagnostics } from "./bybit-private-stream.js";
import { replaceBybitBalances, replaceBybitPositions } from "./bybit-snapshot-store.js";

const BYBIT_DEFAULT_BASE_URLS = ["https://api.bybit.com", "https://api.bytick.com"];
const RECV_WINDOW = "5000";
const BYBIT_REQUEST_TIMEOUT_MS = Math.max(1500, Math.min(8000, Number(process.env.BYBIT_REQUEST_TIMEOUT_MS || 4500)));
const BYBIT_RUNTIME_REGION = process.env.VERCEL_REGION || process.env.AWS_REGION || "local";
const bybitPublicMetadataCache = new Map();
const bybitPermissionCache = new Map();
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
      runtimeRegion: BYBIT_RUNTIME_REGION,
      failedChecks: failedRequiredChecks.map((check) => ({
        name: check.name,
        bybitCode: check.bybitCode,
        httpStatus: check.httpStatus,
        endpoint: check.endpoint,
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
  const cacheKey = `instrument:${category}:${symbol}`;
  const cached = readBybitPublicCache(cacheKey);
  if (cached) return cached;
  const response = await bybitPublicRequest("/v5/market/instruments-info", { category, symbol });
  const list = response?.list || [];
  const metadata = list.map((instrument) => ({
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
    quantityStep: nullableNumber(instrument.lotSizeFilter?.qtyStep || instrument.lotSizeFilter?.basePrecision),
    minQuantity: nullableNumber(instrument.lotSizeFilter?.minOrderQty),
    minNotional: nullableNumber(instrument.lotSizeFilter?.minNotionalValue || instrument.lotSizeFilter?.minOrderAmt),
    maxQuantity: nullableNumber(instrument.lotSizeFilter?.maxOrderQty || instrument.lotSizeFilter?.maxLimitOrderQty),
    pricePrecision: precisionFromStep(instrument.priceFilter?.tickSize),
    quantityPrecision: precisionFromStep(instrument.lotSizeFilter?.qtyStep || instrument.lotSizeFilter?.basePrecision),
    leverageLimits: {
      min: nullableNumber(instrument.leverageFilter?.minLeverage),
      max: nullableNumber(instrument.leverageFilter?.maxLeverage),
      step: nullableNumber(instrument.leverageFilter?.leverageStep)
    },
    supportedMarginModes: category === "spot" ? [] : ["cross", "isolated", "portfolio"],
    supportedTimeInForce: ["GTC", "IOC", "FOK", "PostOnly"],
    supportedTriggerBehavior: { triggerOrders: category !== "spot", takeProfitStopLoss: category !== "spot" },
    tradingStatus: instrument.status || "unknown",
    raw: instrument
  }));
  writeBybitPublicCache(cacheKey, metadata, 60_000);
  return metadata;
}

export async function getBybitRiskLimits({ category = "linear", symbol = "BTCUSDT" } = {}) {
  const cacheKey = `risk:${category}:${symbol}`;
  const cached = readBybitPublicCache(cacheKey);
  if (cached) return cached;
  const response = await bybitPublicRequest("/v5/market/risk-limit", { category, symbol });
  const riskLimits = (response?.list || []).map((tier) => ({
    id: Number(tier.id || 0),
    symbol: tier.symbol,
    riskLimitValue: Number(tier.riskLimitValue || 0),
    maintenanceMargin: Number(tier.maintenanceMargin || 0),
    initialMargin: Number(tier.initialMargin || 0),
    maxLeverage: Number(tier.maxLeverage || 0),
    lowestRisk: Number(tier.isLowestRisk || 0) === 1
  }));
  writeBybitPublicCache(cacheKey, riskLimits, 60_000);
  return riskLimits;
}

export async function getBybitOrderPriceLimit({ category = "linear", symbol = "BTCUSDT" } = {}) {
  const response = await bybitPublicRequest("/v5/market/price-limit", { category, symbol });
  return {
    symbol: response?.symbol || symbol,
    maximumBuyPrice: Number(response?.buyLmt || 0),
    minimumSellPrice: Number(response?.sellLmt || 0),
    updatedAt: Number(response?.ts || Date.now())
  };
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

export async function getBybitStrategies(credentials, { marketKind = "perpetual", symbol } = {}) {
  const response = await bybitRequest(credentials, "GET", "/v5/strategy/list", {
    category: marketKind === "spot" ? "UTA_SPOT" : "UTA_USDT",
    symbol: symbol ? normalizeBybitSymbol(symbol) : undefined,
    pageSize: "50"
  });
  return (response?.list || []).map((strategy) => ({
    strategyId: strategy.strategyId,
    strategyType: strategy.strategyType,
    symbol: strategy.symbol,
    side: String(strategy.side || "").toLowerCase() === "sell" ? "sell" : "buy",
    status: normalizeBybitStrategyStatus(strategy.status),
    quantity: Number(strategy.size || 0),
    filledQuantity: Number(strategy.executedSize || 0),
    averageFillPrice: nullableNumber(strategy.executedAvgPrice),
    reduceOnly: Boolean(strategy.reduceOnly),
    duration: Number(strategy.duration || 0),
    interval: Number(strategy.interval || 0),
    terminateType: Number(strategy.terminateType || 0),
    reason: strategy.terminateRemark || undefined,
    createdAt: Number(strategy.createdTimeE3 || Date.now()),
    updatedAt: Number(strategy.updatedTimeE3 || Date.now()),
    raw: strategy
  }));
}

export async function stopBybitStrategy(credentials, strategyId) {
  if (!strategyId) throw new Error("Bybit strategy stop requires a strategy ID.");
  const response = await bybitRequest(credentials, "POST", "/v5/strategy/stop", {}, { strategyId });
  return {
    exchange: "bybit",
    strategyId: response?.strategyId || strategyId,
    status: "cancelled",
    time: Date.now(),
    raw: response
  };
}

export async function getBybitAccountInfo(credentials) {
  const response = await bybitRequest(credentials, "GET", "/v5/account/info", {});
  const marginMode = String(response?.marginMode || "REGULAR_MARGIN");
  return {
    unifiedMarginStatus: Number(response?.unifiedMarginStatus || 0),
    accountGeneration: Number(response?.unifiedMarginStatus || 0) >= 5 ? "UTA2.0" : "UTA",
    marginMode: marginMode === "ISOLATED_MARGIN" ? "isolated" : marginMode === "PORTFOLIO_MARGIN" ? "portfolio" : "cross",
    rawMarginMode: marginMode,
    updatedAt: Number(response?.updatedTime || Date.now())
  };
}

export async function getBybitDiagnostics(credentials, { symbol = "BTCUSDT" } = {}) {
  const startedAt = Date.now();
  const checks = await Promise.all([
    runBybitDiagnosticCheck("server-time", () => getBybitServerTime(), true),
    runBybitDiagnosticCheck("instrument-metadata", () => getBybitInstrumentMetadata({ category: "linear", symbol }), true),
    runBybitDiagnosticCheck("balances", () => getBybitWalletSnapshot(credentials), true),
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
  const walletSnapshot = diagnosticData(checks, "balances", { balances: [], accountMetrics: emptyBybitAccountMetrics() });
  const balances = walletSnapshot.balances;
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
    accountMetrics: walletSnapshot.accountMetrics,
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

export async function syncBybitAccountToSupabase(supabase, account, credentials, snapshot = {}) {
  const balances = Array.isArray(snapshot.balances) ? snapshot.balances : await getBybitBalances(credentials);
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : await getBybitPositions(credentials);

  await replaceBybitBalances(supabase, account.id, balances);
  await replaceBybitPositions(supabase, account.id, positions);

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

export async function placeBybitOrder(credentials, order, prevalidated = null) {
  const validation = prevalidated || await validateBybitOrderDraft(credentials, order);
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
    qty: formatBybitNumber(validation.normalized.quantity, validation.metadata?.quantityPrecision),
    timeInForce: normalizeBybitTimeInForce(order.timeInForce, order),
    orderLinkId: order.clientOrderId || order.internalOrderId || createBybitClientOrderId()
  };
  if (category === "spot" && orderType === "Market") body.marketUnit = "baseCoin";
  if (orderType === "Market" && Number(order.slippageTolerancePercent) > 0) {
    body.slippageToleranceType = "Percent";
    body.slippageTolerance = String(order.slippageTolerancePercent);
  }

  if (orderType === "Limit" && order.limitPrice) {
    body.price = formatBybitNumber(order.limitPrice, validation.metadata?.pricePrecision);
  }

  if (order.stopPrice) {
    body.triggerPrice = formatBybitNumber(order.stopPrice, validation.metadata?.pricePrecision);
    body.triggerDirection = Number(order.stopPrice) >= Number(order.referencePrice || order.limitPrice || 0) ? 1 : 2;
    if (category !== "spot") body.triggerBy = normalizeBybitTriggerSource(order.triggerBy);
  }

  if (order.takeProfit) {
    body.takeProfit = formatBybitNumber(order.takeProfit, validation.metadata?.pricePrecision);
    if (category !== "spot") body.tpTriggerBy = normalizeBybitTriggerSource(order.tpTriggerBy);
  }

  if (order.stopLoss) {
    body.stopLoss = formatBybitNumber(order.stopLoss, validation.metadata?.pricePrecision);
    if (category !== "spot") body.slTriggerBy = normalizeBybitTriggerSource(order.slTriggerBy);
  }

  if (category !== "spot" && order.reduceOnly) {
    body.reduceOnly = true;
  }

  if (category !== "spot" && order.positionIdx !== undefined) {
    body.positionIdx = Number(order.positionIdx);
  }
  if (category !== "spot" && (order.takeProfit || order.stopLoss)) {
    body.tpslMode = order.tpslMode === "partial" ? "Partial" : "Full";
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

export async function placeBybitStrategyOrder(credentials, order, prevalidated = null) {
  const validation = prevalidated || await validateBybitOrderDraft(credentials, { ...order, orderType: "market" });
  const strategyValidation = validateBybitStrategyParameters(order);
  const reasons = [...(validation.reasons || []), ...strategyValidation.reasons];
  if (reasons.length > 0) {
    const error = new Error(reasons.join(" "));
    error.statusCode = 400;
    error.validation = { ...validation, ok: false, reasons };
    throw error;
  }

  const parameters = order.strategyParameters || {};
  const strategyType = strategyValidation.strategyType;
  const body = {
    category: order.marketKind === "spot" ? "UTA_SPOT" : "UTA_USDT",
    symbol: normalizeBybitSymbol(order.symbol),
    side: order.side === "buy" ? "Buy" : "Sell",
    size: formatBybitNumber(validation.normalized.quantity, validation.metadata?.quantityPrecision),
    strategyType
  };
  if (order.marketKind !== "spot") {
    body.reduceOnly = Boolean(order.reduceOnly);
    body.positionIdx = Number(order.positionIdx || 0);
  }

  if (parameters.triggerPrice) body.triggerPrice = formatBybitNumber(parameters.triggerPrice, validation.metadata?.pricePrecision);
  if (parameters.maxChasePrice) body.maxChasePrice = formatBybitNumber(parameters.maxChasePrice, validation.metadata?.pricePrecision);
  if (parameters.chaseDistance !== undefined) body.chaseDistance = String(parameters.chaseDistance);
  if (parameters.chasePercent !== undefined) body.chasePercentE4 = Math.round(Number(parameters.chasePercent) * 100);

  if (strategyType === "twap") {
    body.duration = Number(parameters.durationSeconds);
    body.interval = Number(parameters.intervalSeconds);
    body.isRandom = Boolean(parameters.randomize);
  }

  if (strategyType === "iceberg") {
    if (parameters.subSize) body.subSize = formatBybitNumber(parameters.subSize, validation.metadata?.quantityPrecision);
    if (parameters.orderCount) body.orderCount = Math.floor(Number(parameters.orderCount));
    body.postOnly = parameters.icebergPreference === "taker" ? 1 : 0;
    if (parameters.icebergPreference === "maker") body.chaseDistance = "0";
    if (parameters.icebergPreference === "taker") body.chaseDistance = "-1";
    if (parameters.icebergPreference === "fixed") {
      delete body.chaseDistance;
      delete body.chasePercentE4;
      body.limitPrice = formatBybitNumber(order.limitPrice, validation.metadata?.pricePrecision);
    }
  }

  if (strategyType === "pov") {
    body.interval = Number(parameters.intervalSeconds || 0);
    if (parameters.durationSeconds) body.duration = Number(parameters.durationSeconds);
    body.povParams = {
      mode: parameters.povMode,
      participationRate: String(parameters.participationRate),
      ...(parameters.povMode === "TradedVolume" ? { referenceWindow: String(parameters.referenceWindowSeconds) } : { depthReference: Number(parameters.depthReference) })
    };
  }

  const response = await bybitRequest(credentials, "POST", "/v5/strategy/create", {}, body);
  return normalizeBybitExecutionReport({
    accountId: order.accountId,
    exchange: "bybit",
    symbol: order.symbol,
    status: "accepted",
    orderId: response?.strategyId,
    filledQuantity: 0,
    raw: { ...response, strategyType, request: body }
  });
}

export function validateBybitStrategyParameters(order) {
  const parameters = order.strategyParameters || {};
  const strategyType = order.orderType === "chase-limit" ? "chaseOrder" : order.orderType;
  const reasons = [];

  if (!["chaseOrder", "twap", "iceberg", "pov"].includes(strategyType)) reasons.push(`Unsupported Bybit strategy ${order.orderType}.`);
  if (strategyType === "twap") {
    const duration = Number(parameters.durationSeconds || 0);
    const interval = Number(parameters.intervalSeconds || 0);
    if (duration < 300 || duration > 86400) reasons.push("Bybit TWAP duration must be between 5 minutes and 24 hours.");
    if (![5, 10, 15, 30, 60, 120].includes(interval)) reasons.push("Bybit TWAP interval must be 5, 10, 15, 30, 60, or 120 seconds.");
    if (interval > 0 && duration % interval !== 0) reasons.push("Bybit TWAP duration must be divisible by its interval.");
  }
  if (strategyType === "chaseOrder" && parameters.chaseDistance === undefined && parameters.chasePercent === undefined) {
    reasons.push("Bybit Chase requires a chase distance or percentage.");
  }
  if (parameters.chasePercent !== undefined && (Number(parameters.chasePercent) < 0 || Number(parameters.chasePercent) > 5)) {
    reasons.push("Bybit Chase percentage must be between 0% and 5%.");
  }
  if (strategyType === "iceberg") {
    if (!Number(parameters.subSize || 0) && !Number(parameters.orderCount || 0)) reasons.push("Bybit Iceberg requires a visible sub-order size or order count.");
    if (parameters.icebergPreference === "fixed" && !Number(order.limitPrice || 0)) reasons.push("Fixed-price Iceberg requires a limit price.");
  }
  if (strategyType === "pov") {
    if (order.marketKind === "spot") reasons.push("Bybit POV supports perpetual and futures products only.");
    const participation = Number(parameters.participationRate || 0);
    const interval = Number(parameters.intervalSeconds || 0);
    if (participation < 1 || participation > 100) reasons.push("Bybit POV participation must be between 1% and 100%.");
    if (interval !== 0 && (interval < 5 || interval > 3600)) reasons.push("Bybit POV interval must be zero or between 5 and 3600 seconds.");
    if (!Number(order.quantity || 0) && !Number(parameters.durationSeconds || 0)) reasons.push("Bybit POV requires a maximum quantity or duration.");
    if (parameters.povMode === "TradedVolume") {
      const window = Number(parameters.referenceWindowSeconds || 0);
      if (window < 60 || window > 14400) reasons.push("Bybit POV traded-volume window must be between 60 and 14,400 seconds.");
    } else {
      const depth = Number(parameters.depthReference || 0);
      if (depth < 1 || depth > 10) reasons.push("Bybit POV depth reference must be between 1 and 10 levels.");
    }
  }

  return { ok: reasons.length === 0, reasons, strategyType };
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
  if (!["cross", "isolated", "portfolio"].includes(marginMode)) throw new Error("Bybit margin mode must be cross, isolated or portfolio.");
  const response = await bybitRequest(credentials, "POST", "/v5/account/set-margin-mode", {}, {
    setMarginMode: marginMode === "cross" ? "REGULAR_MARGIN" : marginMode === "isolated" ? "ISOLATED_MARGIN" : "PORTFOLIO_MARGIN"
  });
  const reasons = Array.isArray(response?.reasons) ? response.reasons.filter((reason) => reason?.reasonCode || reason?.reasonMsg) : [];
  if (reasons.length > 0) {
    const error = new Error(reasons.map((reason) => reason.reasonMsg || reason.reasonCode).join(" "));
    error.statusCode = 400;
    throw error;
  }
  const nextLeverage = leverage || buyLeverage || sellLeverage;
  const leverageReport = symbol && nextLeverage
    ? await setBybitLeverage(credentials, { category, symbol, leverage: nextLeverage, buyLeverage, sellLeverage })
    : null;
  return {
    status: "accepted",
    marginMode,
    accountWide: true,
    leverageReport,
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
  const [metadataRows, priceLimit, riskLimits, positionRows] = await Promise.all([
    getBybitInstrumentMetadata({ category, symbol }),
    getBybitOrderPriceLimit({ category, symbol }),
    category === "spot" ? Promise.resolve([]) : getBybitRiskLimits({ category, symbol }),
    category === "spot" ? Promise.resolve([]) : getBybitPositions(credentials, { symbol, includeEmpty: true })
  ]);
  const metadata = metadataRows[0];
  const normalizedOrder = normalizeBybitSizing(order, metadata);
  const result = evaluateBybitOrderDraftAgainstMetadata(metadata, normalizedOrder, { category, symbol });
  const position = positionRows.find((row) => row.positionIdx === Number(order.positionIdx || 0)) || positionRows[0];
  const riskTier = riskLimits.find((tier) => tier.id === position?.riskId) || riskLimits.find((tier) => tier.lowestRisk) || null;
  const limitPrice = Number(normalizedOrder.limitPrice || 0);
  if (normalizedOrder.side === "buy" && limitPrice > 0 && priceLimit.maximumBuyPrice > 0 && limitPrice > priceLimit.maximumBuyPrice) {
    result.reasons.push(`Buy price exceeds Bybit current price limit ${priceLimit.maximumBuyPrice}.`);
  }
  if (normalizedOrder.side === "sell" && limitPrice > 0 && priceLimit.minimumSellPrice > 0 && limitPrice < priceLimit.minimumSellPrice) {
    result.reasons.push(`Sell price is below Bybit current price limit ${priceLimit.minimumSellPrice}.`);
  }
  if (normalizedOrder.leverage && riskTier?.maxLeverage && Number(normalizedOrder.leverage) > riskTier.maxLeverage) {
    result.reasons.push(`Leverage exceeds the current Bybit risk-tier maximum ${riskTier.maxLeverage}x.`);
  }
  return {
    ...result,
    ok: result.reasons.length === 0,
    priceLimit,
    riskTier,
    requestedSizingMethod: order.sizingMethod || order.quantityMode || "quantity"
  };
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
  if (order.reduceOnly && (order.takeProfit || order.stopLoss)) {
    reasons.push("Bybit does not allow attached take-profit or stop-loss on a reduce-only order.");
  }
  if (order.slippageTolerancePercent !== undefined && (Number(order.slippageTolerancePercent) < 0.01 || Number(order.slippageTolerancePercent) > 10)) {
    reasons.push("Bybit market-order slippage tolerance must be between 0.01% and 10%.");
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
  if (allowedConnections.length > 0 && !allowedConnections.includes("*") && !allowedConnections.includes(account.id)) {
    reasons.push("Bybit account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  }
  if (!allowedSymbols.length || !allowedSymbols.includes("*") && !allowedSymbols.includes(String(order.symbol || "").toUpperCase())) {
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

export function resolveBybitExecutionPolicy(permissionReport = {}) {
  const allowedSymbols = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase());
  const maxNotionalUsd = Number(process.env.BYBIT_MAINNET_MAX_NOTIONAL_USD || 0);
  const reasons = [];

  if (process.env.BYBIT_MAINNET_VALIDATION_ENABLED !== "true") reasons.push("Server-side Bybit trading is disabled.");
  if (permissionReport.trading !== true) reasons.push("The Bybit API key does not have trading permission.");
  if (permissionReport.withdrawal === true) reasons.push("Withdrawal-enabled API keys cannot trade through Black Terminal.");
  if (allowedSymbols.length === 0) reasons.push("No Bybit symbols are enabled by server policy.");
  if (!Number.isFinite(maxNotionalUsd) || maxNotionalUsd <= 0) reasons.push("The server order-notional limit is not configured.");

  const tradingEnabled = reasons.length === 0;
  return {
    tradingEnabled,
    readOnly: !tradingEnabled,
    allowedSymbols,
    maxNotionalUsd,
    readinessReason: reasons.join(" "),
    permissions: tradingEnabled
      ? ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"]
      : ["read-account", "read-orders", "read-positions"]
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
  if (allowedConnections.length > 0 && !allowedConnections.includes("*") && !allowedConnections.includes(account.id)) {
    reasons.push("Bybit account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  }
  if (!allowedSymbols.length || !allowedSymbols.includes("*") && !allowedSymbols.includes(nativeSymbol)) {
    reasons.push("Bybit symbol is not in BYBIT_MAINNET_ALLOWED_SYMBOLS.");
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

export async function getBybitWalletSnapshot(credentials) {
  const response = await bybitRequest(credentials, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
  const account = response?.list?.[0];
  const coins = account?.coin || [];
  const balances = coins
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

  const walletBalanceUsd = nullableNumber(account?.totalWalletBalance) ?? balances.reduce((sum, balance) => sum + balance.usdValue, 0);
  const initialMarginUsd = nullableNumber(account?.totalInitialMargin) ?? 0;
  return {
    balances,
    accountMetrics: {
      accountType: String(account?.accountType || "UNIFIED"),
      walletBalanceUsd,
      equityUsd: nullableNumber(account?.totalEquity) ?? walletBalanceUsd,
      marginBalanceUsd: nullableNumber(account?.totalMarginBalance) ?? walletBalanceUsd,
      availableBalanceUsd: nullableNumber(account?.totalAvailableBalance) ?? Math.max(0, walletBalanceUsd - initialMarginUsd),
      initialMarginUsd,
      maintenanceMarginUsd: nullableNumber(account?.totalMaintenanceMargin) ?? 0,
      unrealizedPnlUsd: nullableNumber(account?.totalPerpUPL) ?? 0,
      accountImRate: nullableNumber(account?.accountIMRate),
      accountMmRate: nullableNumber(account?.accountMMRate),
      updatedAt: Date.now()
    }
  };
}

export async function getBybitBalances(credentials) {
  return (await getBybitWalletSnapshot(credentials)).balances;
}

export async function getBybitPositions(credentials, options = {}) {
  const response = await bybitRequest(credentials, "GET", "/v5/position/list", {
    category: "linear",
    ...(options.symbol ? { symbol: String(options.symbol).toUpperCase() } : { settleCoin: "USDT" }),
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
        positionIdx: Number(position.positionIdx || 0),
        positionMode: Number(position.positionIdx || 0) === 0 ? "one-way" : "hedge",
        marginMode: Number(position.tradeMode || 0) === 1 ? "isolated" : "cross",
        riskId: Number(position.riskId || 0),
        positionValue: Number(position.positionValue || 0),
        openedAt: Number(position.createdTime || position.updatedTime || Date.now())
      };
    })
    .filter((position) => options.includeEmpty || (position.quantity > 0 && position.direction !== "flat"));
}

async function bybitRequest(credentials, method, path, query = {}, body) {
  const queryString = buildQueryString(query);
  const bodyString = body ? JSON.stringify(body) : "";
  const { response, baseUrl } = await fetchBybitWithFallback(path, queryString, () => {
    const timestamp = String(Date.now());
    const payload = method === "GET"
      ? `${timestamp}${credentials.apiKey}${RECV_WINDOW}${queryString}`
      : `${timestamp}${credentials.apiKey}${RECV_WINDOW}${bodyString}`;
    const signature = crypto.createHmac("sha256", credentials.apiSecret).update(payload).digest("hex");

    return {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "cdn-request-id": createBybitRequestId()
      },
      body: method === "GET" ? undefined : bodyString
    };
  });

  const data = await readBybitResponse(response);

  if (!response.ok || data?.retCode !== 0) {
    const bybitCode = data?.retCode;
    const bybitMessage = String(data?.retMsg || "").trim();
    const regionalMessage = response.status === 403
      ? `Bybit rejected the request from server region ${BYBIT_RUNTIME_REGION} (HTTP 403). The execution backend must run outside Bybit-restricted regions.`
      : "";
    const error = new Error(regionalMessage || bybitMessage || `Bybit request failed${bybitCode !== undefined ? ` with retCode ${bybitCode}` : ""} at ${path} (HTTP ${response.status})`);
    error.statusCode = response.status === 401 ? 401 : response.status === 403 ? 503 : 502;
    error.bybit = data;
    error.bybitEndpoint = path;
    error.bybitHttpStatus = response.status;
    error.bybitBaseUrl = baseUrl;
    error.runtimeRegion = BYBIT_RUNTIME_REGION;
    throw error;
  }

  return data.result;
}

export async function getBybitApiKeyInformation(credentials) {
  const cacheKey = crypto.createHash("sha256").update(String(credentials.apiKey || "")).digest("hex").slice(0, 16);
  const cached = bybitPermissionCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < 60_000) return cached.value;
  const value = await bybitRequest(credentials, "GET", "/v5/user/query-api", {});
  bybitPermissionCache.set(cacheKey, { storedAt: Date.now(), value });
  return value;
}

async function bybitPublicRequest(path, query = {}) {
  const queryString = buildQueryString(query);
  const { response, baseUrl } = await fetchBybitWithFallback(path, queryString, {
    headers: {
      "cdn-request-id": createBybitRequestId()
    }
  });
  const data = await readBybitResponse(response);

  if (!response.ok || data?.retCode !== 0) {
    const regionalMessage = response.status === 403
      ? `Bybit rejected the public request from server region ${BYBIT_RUNTIME_REGION} (HTTP 403).`
      : "";
    const error = new Error(regionalMessage || data?.retMsg || `Bybit public request failed with HTTP ${response.status}`);
    error.statusCode = response.status === 404 ? 404 : response.status === 403 ? 503 : 502;
    error.bybit = data;
    error.bybitEndpoint = path;
    error.bybitHttpStatus = response.status;
    error.bybitBaseUrl = baseUrl;
    error.runtimeRegion = BYBIT_RUNTIME_REGION;
    throw error;
  }

  return data.result;
}

async function fetchWithTimeout(url, options = {}, endpoint = "bybit") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BYBIT_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    const wrapped = new Error(
      timedOut
        ? `Bybit request timed out after ${BYBIT_REQUEST_TIMEOUT_MS}ms at ${endpoint}.`
        : `Bybit request failed at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`
    );
    wrapped.statusCode = timedOut ? 504 : 502;
    wrapped.bybitEndpoint = endpoint;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBybitWithFallback(path, queryString, options) {
  const baseUrls = getBybitBaseUrls();
  let lastError = null;

  for (let index = 0; index < baseUrls.length; index += 1) {
    const baseUrl = baseUrls[index];
    const url = `${baseUrl}${path}${queryString ? `?${queryString}` : ""}`;

    try {
      const requestOptions = typeof options === "function" ? options() : options;
      const response = await fetchWithTimeout(url, requestOptions, path);
      const canRetry = response.status === 403 || response.status >= 500;
      if (canRetry && index < baseUrls.length - 1) continue;
      return { response, baseUrl };
    } catch (error) {
      lastError = error;
      if (index >= baseUrls.length - 1) {
        error.bybitBaseUrl = baseUrl;
        error.runtimeRegion = BYBIT_RUNTIME_REGION;
        throw error;
      }
    }
  }

  throw lastError || new Error("No Bybit API endpoint is configured.");
}

function getBybitBaseUrls() {
  const configured = String(process.env.BYBIT_BASE_URL || "").trim().replace(/\/$/, "");
  return [...new Set([configured, ...BYBIT_DEFAULT_BASE_URLS].filter(Boolean))];
}

function createBybitRequestId() {
  return `bt-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

async function readBybitResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
      httpStatus: error?.bybitHttpStatus || null,
      endpoint: error?.bybitEndpoint || null,
      baseUrl: error?.bybitBaseUrl || null,
      runtimeRegion: error?.runtimeRegion || BYBIT_RUNTIME_REGION
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
  if (Number(error?.bybitHttpStatus) === 403) {
    return `${name} failed (HTTP 403): ${baseMessage} Bybit blocks API traffic from restricted server regions; current runtime region: ${error?.runtimeRegion || BYBIT_RUNTIME_REGION}.`;
  }
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

export function normalizeBybitSizing(order, metadata) {
  const sizingMethod = String(order.sizingMethod || order.quantityMode || "quantity");
  if (sizingMethod !== "usd") return order;

  const usdValue = Number(order.quantity || 0);
  const referencePrice = Number(order.referencePrice || order.limitPrice || order.stopPrice || 0);
  if (!Number.isFinite(usdValue) || usdValue <= 0 || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { ...order, quantity: 0 };
  }

  const rawQuantity = usdValue / referencePrice;
  const step = Number(metadata?.quantityStep || 0);
  const quantity = step > 0
    ? Number((Math.floor((rawQuantity + 1e-12) / step) * step).toFixed(metadata?.quantityPrecision ?? 8))
    : rawQuantity;
  return { ...order, quantity };
}

function emptyBybitAccountMetrics() {
  return {
    accountType: "UNIFIED",
    walletBalanceUsd: 0,
    equityUsd: 0,
    marginBalanceUsd: 0,
    availableBalanceUsd: 0,
    initialMarginUsd: 0,
    maintenanceMarginUsd: 0,
    unrealizedPnlUsd: 0,
    accountImRate: null,
    accountMmRate: null,
    updatedAt: Date.now()
  };
}

export function normalizeBybitOrderType(orderType) {
  if (orderType === "market") return "Market";
  if (orderType === "stop-market") return "Market";
  if (["chase-limit", "twap", "iceberg", "pov"].includes(orderType)) return "Market";
  if (["trailing-stop"].includes(orderType)) {
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

export function normalizeBybitTriggerSource(value) {
  if (value === "mark") return "MarkPrice";
  if (value === "index") return "IndexPrice";
  return "LastPrice";
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBybitPublicCache(key) {
  const cached = bybitPublicMetadataCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    bybitPublicMetadataCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeBybitPublicCache(key, value, ttlMs) {
  bybitPublicMetadataCache.set(key, { value, expiresAt: Date.now() + ttlMs });
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

export function normalizeBybitStrategyStatus(status) {
  const value = Number(status);
  if (value === 2) return "working";
  if (value === 3) return "filled";
  if (value === 4) return "cancelled";
  if (value === 5) return "paused";
  if (value === 6) return "pending";
  return "pending";
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
