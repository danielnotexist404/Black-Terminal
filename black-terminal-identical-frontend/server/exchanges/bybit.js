import crypto from "node:crypto";
import { getBybitPrivateStreamRuntimeDiagnostics } from "./bybit-private-stream.js";
import { replaceBybitBalances, replaceBybitPositions, upsertBybitAccountEquitySnapshot } from "./bybit-snapshot-store.js";
import {
  BYBIT_EXECUTION_ENVIRONMENTS,
  normalizeBybitExecutionEnvironment,
  resolveBybitEndpointSet
} from "./bybit-endpoints.js";

const RECV_WINDOW = "5000";
const BYBIT_REQUEST_TIMEOUT_MS = Math.max(1500, Math.min(8000, Number(process.env.BYBIT_REQUEST_TIMEOUT_MS || 4500)));
const BYBIT_RUNTIME_REGION = process.env.VERCEL_REGION || process.env.AWS_REGION || "local";
const bybitPublicMetadataCache = new Map();
const bybitPermissionCache = new Map();
const bybitRequestStartGates = new Map();
const BYBIT_MIN_REQUEST_SPACING_MS = Math.max(10, Math.min(250, Number(process.env.BYBIT_MIN_REQUEST_SPACING_MS || 25)));
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

export async function getBybitServerTime(routing = {}) {
  const response = await bybitPublicRequest("/v5/market/time", {}, routing);
  const serverTimeMs = Number(response?.timeNano ? Math.floor(Number(response.timeNano) / 1_000_000) : response?.timeSecond ? Number(response.timeSecond) * 1000 : Date.now());
  return {
    serverTimeMs,
    serverTime: new Date(serverTimeMs).toISOString(),
    localTimeMs: Date.now(),
    clockSkewMs: Date.now() - serverTimeMs
  };
}

export async function getBybitTicker({ category = "linear", symbol = "BTCUSDT", network, executionEnvironment, endpointProfile } = {}) {
  const response = await bybitPublicRequest("/v5/market/tickers", { category, symbol }, { network, executionEnvironment, endpointProfile });
  const ticker = response?.list?.[0];
  if (!ticker) throw new Error(`Bybit ticker is unavailable for ${symbol}.`);
  return {
    symbol: ticker.symbol || symbol,
    lastPrice: Number(ticker.lastPrice || 0),
    markPrice: nullableNumber(ticker.markPrice),
    indexPrice: nullableNumber(ticker.indexPrice),
    bidPrice: nullableNumber(ticker.bid1Price),
    askPrice: nullableNumber(ticker.ask1Price),
    updatedAt: Number(response?.time || Date.now())
  };
}

export async function getBybitInstrumentMetadata({ category = "linear", symbol = "BTCUSDT", network, executionEnvironment, endpointProfile } = {}) {
  const cacheKey = `instrument:${executionEnvironment || network || "default"}:${endpointProfile || "GLOBAL"}:${category}:${symbol}`;
  const cached = readBybitPublicCache(cacheKey);
  if (cached) return cached;
  const response = await bybitPublicRequest("/v5/market/instruments-info", { category, symbol }, { network, executionEnvironment, endpointProfile });
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
    maxMarketQuantity: nullableNumber(instrument.lotSizeFilter?.maxMktOrderQty || instrument.lotSizeFilter?.maxMarketOrderQty),
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

export async function getBybitFeeRates(credentials, { category = "linear", symbol } = {}) {
  const response = await bybitRequest(credentials, "GET", "/v5/account/fee-rate", { category, symbol });
  const row = response?.list?.[0];
  const makerRate = Number(row?.makerFeeRate);
  const takerRate = Number(row?.takerFeeRate);
  if (!Number.isFinite(makerRate) || !Number.isFinite(takerRate) || makerRate < 0 || takerRate < 0) {
    const error = new Error("Bybit did not return a valid account fee schedule.");
    error.code = "BYBIT_FEE_SCHEDULE_UNAVAILABLE";
    throw error;
  }
  const observedAt = Date.now();
  return {
    makerRate,
    takerRate,
    source: "ACCOUNT_API",
    observedAt,
    version: `bybit:${category}:${symbol || "account"}:${observedAt}`,
  };
}

export async function getBybitRiskLimits({ category = "linear", symbol = "BTCUSDT", network, executionEnvironment, endpointProfile } = {}) {
  const cacheKey = `risk:${network || "default"}:${category}:${symbol}`;
  const cached = readBybitPublicCache(cacheKey);
  if (cached) return cached;
  const response = await bybitPublicRequest("/v5/market/risk-limit", { category, symbol }, { network, executionEnvironment, endpointProfile });
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

export async function getBybitOrderPriceLimit({ category = "linear", symbol = "BTCUSDT", network, executionEnvironment, endpointProfile } = {}) {
  const response = await bybitPublicRequest("/v5/market/price-limit", { category, symbol }, { network, executionEnvironment, endpointProfile });
  return {
    symbol: response?.symbol || symbol,
    maximumBuyPrice: Number(response?.buyLmt || 0),
    minimumSellPrice: Number(response?.sellLmt || 0),
    updatedAt: Number(response?.ts || Date.now())
  };
}

export async function getBybitOpenOrders(credentials, { category = "linear", symbol, settleCoin, baseCoin, maxPages = 20 } = {}) {
  const ordersById = new Map();
  const processedCursors = new Set();
  let cursor;
  let pages = 0;
  let rawRecordCount = 0;
  let duplicateRecordCount = 0;
  let repeatedCursor = false;

  do {
    const cursorKey = cursor || "__FIRST_PAGE__";
    if (processedCursors.has(cursorKey)) {
      repeatedCursor = true;
      break;
    }
    processedCursors.add(cursorKey);
    const response = await bybitRequest(credentials, "GET", "/v5/order/realtime", {
      category,
      symbol,
      settleCoin,
      baseCoin,
      cursor,
      limit: "50",
      openOnly: "0"
    });
    for (const rawOrder of response?.list || []) {
      rawRecordCount += 1;
      const order = normalizeBybitVenueOrder(rawOrder, category);
      const key = `${category}:${order.venueOrderId}`;
      const current = ordersById.get(key);
      if (current) duplicateRecordCount += 1;
      if (!current || orderVersion(order) >= orderVersion(current)) ordersById.set(key, order);
    }
    const nextCursor = response?.nextPageCursor || undefined;
    if (nextCursor && processedCursors.has(nextCursor)) {
      repeatedCursor = true;
      break;
    }
    cursor = nextCursor;
    pages += 1;
  } while (cursor && pages < maxPages);

  return {
    orders: Array.from(ordersById.values()),
    diagnostics: {
      category,
      pages,
      rawRecordCount,
      uniqueRecordCount: ordersById.size,
      duplicateRecordCount,
      repeatedCursor,
      cursorLimitReached: Boolean(cursor && pages >= maxPages)
    }
  };
}

export async function getBybitExecutions(credentials, { category = "linear", symbol, startTime, endTime, maxPages = 20 } = {}) {
  const executions = [];
  const seen = new Set();
  let cursor;
  let pages = 0;
  do {
    const response = await bybitRequest(credentials, "GET", "/v5/execution/list", {
      category, symbol, startTime, endTime, cursor, limit: "100"
    });
    for (const row of response?.list || []) {
      const identity = String(row.execId || `${row.orderId}:${row.execTime}:${row.execQty}`);
      if (seen.has(identity)) continue;
      seen.add(identity);
      executions.push({
        executionId: identity,
        orderId: row.orderId || null,
        clientOrderId: row.orderLinkId || null,
        symbol: row.symbol,
        side: String(row.side || "").toLowerCase(),
        quantity: Number(row.execQty || 0),
        price: Number(row.execPrice || 0),
        fee: Number(row.execFee || 0),
        feeAsset: row.feeCurrency || null,
        isMaker: Boolean(row.isMaker),
        timestamp: Number(row.execTime || 0)
      });
    }
    cursor = response?.nextPageCursor || undefined;
    pages += 1;
  } while (cursor && pages < maxPages);
  return executions;
}

export async function findBybitOrderByClientOrderId(credentials, { marketKind = "perpetual", symbol, clientOrderId }) {
  if (!clientOrderId) throw new Error("Bybit client order ID is required for reconciliation.");
  const category = marketKind === "spot" ? "spot" : marketKind === "inverse" ? "inverse" : "linear";
  const query = { category, symbol, orderLinkId: clientOrderId, limit: "1" };
  const realtime = await bybitRequest(credentials, "GET", "/v5/order/realtime", query);
  const realtimeOrder = realtime?.list?.[0];
  if (realtimeOrder) return normalizeBybitVenueOrder(realtimeOrder, category);

  const history = await bybitRequest(credentials, "GET", "/v5/order/history", query);
  const historicalOrder = history?.list?.[0];
  return historicalOrder ? normalizeBybitVenueOrder(historicalOrder, category) : null;
}

export async function getBybitOpenOrdersSnapshot(credentials, options = {}) {
  const startedAt = Date.now();
  const network = options.network || "mainnet";
  const requestedCategories = [...new Set(options.categories || ["linear", "inverse", "spot", "option"])];
  const scopes = options.scopes || requestedCategories.flatMap((category) => category === "linear"
    ? [
      { category, settleCoin: "USDT", scopeKey: "linear:USDT" },
      { category, settleCoin: "USDC", scopeKey: "linear:USDC" }
    ]
    : [{ category, scopeKey: category }]);
  const scopeResults = await Promise.all(scopes.map(async (scope) => {
    try {
      const result = await getBybitOpenOrders(credentials, {
        category: scope.category,
        settleCoin: scope.settleCoin,
        baseCoin: scope.baseCoin,
        symbol: scope.symbol || options.symbolByCategory?.[scope.category]
      });
      return { ...scope, status: "ok", orders: result.orders, diagnostics: result.diagnostics };
    } catch (error) {
      return {
        ...scope,
        status: "failed",
        orders: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
  const failedCategories = scopeResults.filter((result) => result.status === "failed").map((result) => ({
    category: result.scopeKey,
    error: result.error
  }));
  const successfulCategories = requestedCategories.filter((category) =>
    scopeResults.filter((result) => result.category === category).every((result) => result.status === "ok")
  );
  const uniqueOrders = new Map();
  let duplicateRecordCount = 0;
  for (const order of scopeResults.flatMap((result) => result.orders)) {
    const key = `${network}:bybit:${order.category}:${order.venueOrderId}`;
    const current = uniqueOrders.get(key);
    if (current) duplicateRecordCount += 1;
    if (!current || orderVersion(order) >= orderVersion(current)) {
      uniqueOrders.set(key, { ...order, network });
    }
  }
  const orders = Array.from(uniqueOrders.values());
  const ordersPerCategory = Object.fromEntries(requestedCategories.map((category) => [
    category,
    scopeResults.filter((result) => result.category === category).reduce((total, result) => total + result.orders.length, 0)
  ]));
  const syncedAt = Date.now();

  return {
    orders,
    health: {
      network,
      endpoint: "/v5/order/realtime",
      requestedCategories,
      successfulCategories,
      failedCategories,
      ordersPerCategory,
      pagination: Object.fromEntries(scopeResults.map((result) => [result.scopeKey, result.diagnostics || null])),
      duplicateRecordCount: duplicateRecordCount + scopeResults.reduce((total, result) => total + Number(result.diagnostics?.duplicateRecordCount || 0), 0),
      activeOrderCount: orders.length,
      verified: failedCategories.length === 0,
      stale: failedCategories.length > 0,
      syncedAt,
      latencyMs: syncedAt - startedAt
    }
  };
}

export function normalizeBybitVenueOrder(order, category = order?.category || "linear") {
  const quantity = Number(order?.qty || 0);
  const filledQuantity = Number(order?.cumExecQty || 0);
  const leavesQuantity = order?.leavesQty === undefined || order?.leavesQty === ""
    ? Math.max(0, quantity - filledQuantity)
    : Number(order.leavesQty || 0);
  const orderId = String(order?.orderId || "");
  const symbol = String(order?.symbol || "").toUpperCase();
  const createdTime = Number(order?.createdTime || order?.updatedTime || Date.now());
  const updatedTime = Number(order?.updatedTime || createdTime);

  return {
    internalId: `bybit:${category}:${orderId}`,
    orderId,
    venueOrderId: orderId,
    clientOrderId: order?.orderLinkId || undefined,
    orderLinkId: order?.orderLinkId || undefined,
    exchange: "bybit",
    venue: "bybit",
    network: "mainnet",
    category,
    marketKind: category === "spot" ? "spot" : "perpetual",
    symbol,
    normalizedSymbol: normalizeBybitSymbol(symbol),
    side: String(order?.side || "").toLowerCase() === "sell" ? "sell" : "buy",
    type: String(order?.orderType || "").toLowerCase(),
    orderType: String(order?.orderType || "").toLowerCase(),
    status: normalizeBybitOrderStatus(order?.orderStatus),
    price: nullableNumber(order?.price),
    venuePriceString: order?.price === undefined || order?.price === null ? undefined : String(order.price),
    triggerPrice: nullableNumber(order?.triggerPrice),
    quantity,
    leavesQuantity,
    remainingQuantity: leavesQuantity,
    filledQuantity,
    cumulativeFilledQuantity: filledQuantity,
    averageFillPrice: nullableNumber(order?.avgPrice),
    timeInForce: String(order?.timeInForce || "").toLowerCase(),
    reduceOnly: Boolean(order?.reduceOnly),
    closeOnTrigger: Boolean(order?.closeOnTrigger),
    positionIdx: Number(order?.positionIdx || 0),
    source: "venue",
    ownership: order?.orderLinkId?.startsWith?.("bt-") ? "black-terminal" : "external",
    externallyCreated: !order?.orderLinkId?.startsWith?.("bt-"),
    createdTime,
    updatedTime,
    createdAt: createdTime,
    updatedAt: updatedTime,
    rawVersion: updatedTime
  };
}

function orderVersion(order) {
  return Number(order?.rawVersion || order?.updatedTime || order?.updatedAt || order?.createdTime || 0);
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
  const endpointSet = resolveBybitEndpointSet(credentials);
  const checks = await Promise.all([
    runBybitDiagnosticCheck("server-time", () => getBybitServerTime(credentials), true),
    runBybitDiagnosticCheck("instrument-metadata", () => getBybitInstrumentMetadata({ category: "linear", symbol, executionEnvironment: endpointSet.environment, endpointProfile: endpointSet.region }), true),
    runBybitDiagnosticCheck("balances", () => getBybitWalletSnapshot(credentials), true),
    runBybitDiagnosticCheck("positions", () => getBybitPositions(credentials), true),
    runBybitDiagnosticCheck("open-orders", () => getBybitOpenOrdersSnapshot(credentials, { categories: ["linear", "spot"], settleCoin: "USDT", network: endpointSet.environment }), true),
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
  const openOrderSnapshot = diagnosticData(checks, "open-orders", { orders: [], health: { stale: true, verified: false } });
  const openOrders = openOrderSnapshot.orders;
  const apiKeyInfo = diagnosticData(checks, "api-key-permissions", {
    readOnly: true,
    permissions: {},
    error: checks.find((check) => check.name === "api-key-permissions")?.message || "Bybit API-key permission probe did not complete."
  });
  const permissionReport = normalizeBybitPermissionReport(apiKeyInfo);
  const privateStreamRuntime = getBybitPrivateStreamRuntimeDiagnostics();
  const privateStreamsReady = privateStreamRuntime.status === "connected" && privateStreamRuntime.authenticated === true;
  const isMainnet = endpointSet.environment === BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE;
  const mainnetValidationEnabled = !isMainnet || process.env.BYBIT_MAINNET_VALIDATION_ENABLED === "true";
  const orderReadReady = openOrderSnapshot.health?.verified === true;
  const accountReadReady = requiredFailures.length === 0 && orderReadReady;
  const executionReady = Boolean(accountReadReady && mainnetValidationEnabled && permissionReport.trading && !permissionReport.transfer && !permissionReport.withdrawal && privateStreamsReady);
  const readinessReason = executionReady
    ? "Bybit execution readiness checks passed for controlled mainnet validation."
    : [
        !accountReadReady ? `Bybit account read validation failed: ${requiredFailures.map((check) => check.message).join(" ")} ${orderReadReady ? "" : "Open-order category verification is incomplete."}`.trim() : "",
        !mainnetValidationEnabled ? "BYBIT_MAINNET_VALIDATION_ENABLED is not true for this mainnet account." : "",
        !permissionReport.trading ? "Bybit API key is read-only or lacks both contract Order and Position permissions." : "",
        permissionReport.transfer ? "Bybit API key has wallet transfer permission, which is not required for execution." : "",
        permissionReport.withdrawal ? "Bybit API key has forbidden withdrawal permission." : "",
        !privateStreamsReady ? "Bybit private stream runtime is not authenticated and connected." : ""
      ].filter(Boolean).join(" ");

  return {
    venueId: "bybit",
    provider: "bybit",
    network: endpointSet.environment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "demo" : "mainnet",
    executionEnvironment: endpointSet.environment,
    endpointProfile: endpointSet.region,
    accountUid: String(apiKeyInfo.userID ?? apiKeyInfo.userId ?? ""),
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
      transfer: permissionReport.transfer,
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
    orderSync: openOrderSnapshot.health,
    apiKeyInfo,
    permissionSnapshot: permissionReport.snapshot,
    environmentTruth: endpointSet.environment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO
      ? { badge: "BYBIT DEMO", funds: "SIMULATED FUNDS", marketData: "MAINNET PUBLIC MARKET DATA", execution: "SIMULATED EXECUTION" }
      : { badge: "BYBIT MAINNET LIVE", funds: "REAL FUNDS", marketData: "MAINNET PUBLIC MARKET DATA", execution: "REAL EXECUTION" },
    endpointCapabilities: {
      region: endpointSet.region,
      websocketOrderEntrySupported: endpointSet.websocketOrderEntrySupported,
      orderTransport: endpointSet.websocketOrderEntrySupported ? "REST_OR_WEBSOCKET" : "REST_ONLY"
    },
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
  const snapshotStartedAt = Date.now();
  const suppliedWallet = Array.isArray(snapshot.balances) && snapshot.accountMetrics
    ? { balances: snapshot.balances, accountMetrics: snapshot.accountMetrics }
    : null;
  const walletSnapshot = suppliedWallet || await getBybitWalletSnapshot(credentials);
  const balances = Array.isArray(snapshot.balances) ? snapshot.balances : walletSnapshot.balances;
  const accountMetrics = snapshot.accountMetrics || walletSnapshot.accountMetrics;
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : await getBybitPositions(credentials);
  const synchronizedAt = new Date().toISOString();
  const executionEnvironment = normalizeBybitExecutionEnvironment(credentials.executionEnvironment || account.execution_environment || credentials.network || account.network);

  await replaceBybitBalances(supabase, account.id, balances);
  await upsertBybitAccountEquitySnapshot(supabase, {
    accountId: account.id,
    userId: account.user_id,
    executionEnvironment,
    accountMetrics,
    capturedAt: synchronizedAt
  });
  await replaceBybitPositions(supabase, account.id, positions, snapshotStartedAt);

  const equityUsd = Number(accountMetrics.equityUsd);
  const marginUsed = positions.reduce((sum, position) => sum + position.margin, 0);

  const { error: accountUpdateError } = await supabase
    .from("exchange_accounts")
    .update({
      status: "connected",
      api_health: "healthy",
      latency_ms: 0,
      last_synced_at: synchronizedAt,
      last_sync_error: null
    })
    .eq("id", account.id);
  if (accountUpdateError) throw accountUpdateError;

  return {
    balances,
    accountMetrics,
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
    error.code = validation.codes?.[0] || "BYBIT_ORDER_VALIDATION_FAILED";
    error.validation = validation;
    throw error;
  }

  const body = buildBybitOrderRequestBody(order, validation);

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

/** Pure request builder used by offline execution certification. */
export function buildBybitOrderRequestBody(order, validation) {
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
  if (orderType === "Market" && Number(order.slippageToleranceTicks) > 0) {
    body.slippageToleranceType = "TickSize";
    body.slippageTolerance = String(Math.max(1, Math.min(10_000, Math.floor(Number(order.slippageToleranceTicks)))));
  } else if (orderType === "Market" && Number(order.slippageTolerancePercent) > 0) {
    const boundedPercent = Math.max(0.01, Math.min(10, Math.floor(Number(order.slippageTolerancePercent) * 100 + 1e-9) / 100));
    body.slippageToleranceType = "Percent";
    body.slippageTolerance = boundedPercent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
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

  return body;
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
  const body = buildBybitModifyOrderRequestBody(patch);
  const response = await bybitRequest(credentials, "POST", "/v5/order/amend", {}, body);
  return normalizeBybitExecutionReport({
    exchange: "bybit",
    symbol: patch.symbol,
    status: "working",
    orderId: response?.orderId || patch.orderId,
    clientOrderId: response?.orderLinkId || patch.clientOrderId
  });
}

export function buildBybitModifyOrderRequestBody(patch) {
  const category = patch.category === "inverse" ? "inverse" : patch.marketKind === "spot" ? "spot" : "linear";
  return {
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
  const category = patch.category === "inverse" ? "inverse" : patch.marketKind === "spot" ? "spot" : "linear";
  if (category === "spot") throw new Error("Bybit spot does not support native futures TP/SL protection.");
  const body = buildBybitTradingStopBody({ ...patch, category });
  let response;
  let idempotentNoop = false;
  try {
    response = await bybitRequest(credentials, "POST", "/v5/position/trading-stop", {}, body);
  } catch (error) {
    if (!isBybitProtectionNoopError(error)) throw error;
    // Bybit retCode 34040 means the requested TP/SL state is already present
    // (or the request was incomplete). The caller must still reconcile the
    // authoritative position before this can be reported as successful.
    idempotentNoop = true;
    response = null;
  }
  return {
    status: "accepted",
    protectionMode: "native",
    idempotentNoop,
    symbol: patch.symbol,
    positionIdx: patch.positionIdx,
    takeProfit: patch.takeProfit ?? null,
    stopLoss: patch.stopLoss ?? null,
    trailingStop: patch.trailingStop ?? null,
    raw: response
  };
}

export function isBybitProtectionNoopError(error) {
  return Number(error?.bybit?.retCode) === 34040;
}

export function buildBybitTradingStopBody(patch) {
  const category = patch.category === "inverse" ? "inverse" : patch.marketKind === "spot" ? "spot" : "linear";
  if (category === "spot") throw new Error("Bybit spot does not support native futures TP/SL protection.");
  const positionIdx = Number(patch.positionIdx);
  if (!Number.isInteger(positionIdx) || ![0, 1, 2].includes(positionIdx)) throw new Error("Bybit native protection requires an explicit positionIdx (0, 1, or 2).");
  const numericIntent = (name, value) => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Bybit ${name} must be a finite non-negative number.`);
    return String(value);
  };
  const triggerBy = (value) => value === "mark" ? "MarkPrice" : value === "index" ? "IndexPrice" : "LastPrice";
  const body = {
    category,
    symbol: patch.symbol,
    tpslMode: patch.tpslMode === "partial" ? "Partial" : "Full",
    positionIdx,
    takeProfit: numericIntent("takeProfit", patch.takeProfit),
    stopLoss: numericIntent("stopLoss", patch.stopLoss),
    trailingStop: numericIntent("trailingStop", patch.trailingStop),
    activePrice: numericIntent("trailingActivationPrice", patch.trailingActivationPrice),
    ...(patch.takeProfit !== undefined ? { tpTriggerBy: triggerBy(patch.tpTriggerBy) } : {}),
    ...(patch.stopLoss !== undefined ? { slTriggerBy: triggerBy(patch.slTriggerBy) } : {})
  };
  if (body.takeProfit === undefined && body.stopLoss === undefined && body.trailingStop === undefined) throw new Error("Bybit native protection requires an explicit set or cancel intent.");
  return body;
}

export async function setBybitLeverage(credentials, { category = "linear", symbol, leverage, buyLeverage, sellLeverage }) {
  if (!symbol) throw new Error("Bybit leverage update requires a symbol.");
  if (!leverage && !buyLeverage && !sellLeverage) throw new Error("Bybit leverage update requires leverage.");
  const body = buildBybitLeverageRequestBody({ category, symbol, leverage, buyLeverage, sellLeverage });
  const nextBuyLeverage = body.buyLeverage;
  const nextSellLeverage = body.sellLeverage;
  let response;
  try {
    response = await bybitRequest(credentials, "POST", "/v5/position/set-leverage", {}, body);
  } catch (error) {
    // Bybit retCode 110043 is an idempotent no-op: the requested leverage is
    // already active. It is not a broker outage and must not block trading.
    if (!isBybitLeverageAlreadySet(error)) throw error;
    return {
      status: "unchanged",
      unchanged: true,
      symbol,
      buyLeverage: Number(nextBuyLeverage),
      sellLeverage: Number(nextSellLeverage),
      venueCode: Number(error?.bybit?.retCode || 110043)
    };
  }
  return {
    status: "accepted",
    symbol,
    buyLeverage: Number(nextBuyLeverage),
    sellLeverage: Number(nextSellLeverage),
    raw: response
  };
}

/** Pure request builder used by offline execution certification. */
export function buildBybitLeverageRequestBody({ category = "linear", symbol, leverage, buyLeverage, sellLeverage }) {
  if (!symbol) throw new Error("Bybit leverage update requires a symbol.");
  if (!leverage && !buyLeverage && !sellLeverage) throw new Error("Bybit leverage update requires leverage.");
  return {
    category,
    symbol,
    buyLeverage: String(buyLeverage || leverage),
    sellLeverage: String(sellLeverage || leverage)
  };
}

export function isBybitLeverageAlreadySet(error) {
  const code = Number(error?.bybit?.retCode);
  const message = String(error?.bybit?.retMsg || error?.message || "").trim().toLowerCase();
  return code === 110043 || /(?:set )?leverage (?:has )?not (?:been )?modified/.test(message);
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
  const endpointSet = resolveBybitEndpointSet(credentials);
  const routing = { executionEnvironment: endpointSet.environment, endpointProfile: endpointSet.region };
  const [metadataRows, priceLimit, riskLimits, positionRows] = await Promise.all([
    getBybitInstrumentMetadata({ category, symbol, ...routing }),
    getBybitOrderPriceLimit({ category, symbol, ...routing }),
    category === "spot" ? Promise.resolve([]) : getBybitRiskLimits({ category, symbol, ...routing }),
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
  const codes = [];
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
    codes.push("ORDER_ABOVE_EXCHANGE_MAXIMUM");
  }
  if (orderType === "Market" && metadata?.maxMarketQuantity && quantity > metadata.maxMarketQuantity) {
    reasons.push(`Market quantity exceeds Bybit current maximum ${metadata.maxMarketQuantity}. Source: Bybit instrument metadata.`);
    codes.push("ORDER_ABOVE_EXCHANGE_MARKET_MAXIMUM");
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
    reasons.push(`ORDER_BELOW_EXCHANGE_MINIMUM — Requested notional: $${notional.toFixed(2)}. Current minimum: $${Number(metadata.minNotional).toFixed(2)}. Source: Bybit instrument metadata.`);
    codes.push("ORDER_BELOW_EXCHANGE_MINIMUM");
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
  if (order.slippageToleranceTicks !== undefined && (!Number.isInteger(Number(order.slippageToleranceTicks)) || Number(order.slippageToleranceTicks) < 1 || Number(order.slippageToleranceTicks) > 10_000)) {
    reasons.push("Bybit tick-size slippage tolerance must be an integer between 1 and 10000.");
  }
  if (order.slippageToleranceTicks !== undefined && order.slippageTolerancePercent !== undefined) {
    reasons.push("Choose either tick-size or percent slippage tolerance, not both.");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    codes,
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
  const environment = normalizeBybitExecutionEnvironment(account?.execution_environment || account?.network);

  if (environment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO) {
    if (!validation?.ok) reasons.push(...(validation?.reasons || ["Bybit venue validation failed."]));
    return { ok: reasons.length === 0, reasons, maxNotionalUsd: 0, environment };
  }

  if (process.env.BYBIT_MAINNET_VALIDATION_ENABLED !== "true") {
    reasons.push("BYBIT_MAINNET_VALIDATION_ENABLED must be true.");
  }
  if (order.mainnetConfirmed !== true || order.liveConfirmation !== BYBIT_MAINNET_LIVE_CONFIRMATION) {
    reasons.push(`Each Bybit mainnet validation order requires explicit per-order confirmation: ${BYBIT_MAINNET_LIVE_CONFIRMATION}.`);
  }
  if (allowedConnections.length > 0 && !allowedConnections.includes("*") && !allowedConnections.includes(account.id)) {
    reasons.push("Bybit account is not in BYBIT_MAINNET_ALLOWED_CONNECTIONS.");
  }
  if (!validation?.ok) {
    reasons.push(...(validation?.reasons || ["Bybit venue validation failed."]));
  }

  return {
    ok: reasons.length === 0,
    reasons,
    maxNotionalUsd: 0,
    environment
  };
}

export function resolveBybitExecutionPolicy(permissionReport = {}, options = {}) {
  const environment = normalizeBybitExecutionEnvironment(options.executionEnvironment || options.network);
  const allowedSymbols = splitCsv(process.env.BYBIT_MAINNET_ALLOWED_SYMBOLS).map((item) => item.toUpperCase());
  const reasons = [];

  if (environment === BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE && process.env.BYBIT_MAINNET_VALIDATION_ENABLED !== "true") reasons.push("Server-side Bybit Mainnet Live trading is disabled.");
  if (environment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO && process.env.BYBIT_DEMO_ENABLED !== "true") reasons.push("Server-side Bybit Demo trading is disabled.");
  if (permissionReport.trading !== true) reasons.push("The Bybit API key does not have trading permission.");
  if (permissionReport.withdrawal === true) reasons.push("Withdrawal-enabled API keys cannot trade through Black Terminal.");
  if (permissionReport.transfer === true) reasons.push("Wallet-transfer-enabled API keys cannot trade through Black Terminal.");
  const tradingEnabled = reasons.length === 0;
  return {
    tradingEnabled,
    readOnly: !tradingEnabled,
    allowedSymbols: allowedSymbols.length ? allowedSymbols : ["*"],
    maxNotionalUsd: 0,
    capacityMode: "broker-metadata-account-margin-and-user-policy",
    executionEnvironment: environment,
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
  const maxPages = Math.max(1, Math.min(100, Number(options.maxPages || 20)));
  const scopes = options.symbol
    ? [{ category: options.category || "linear", symbol: String(options.symbol).toUpperCase() }]
    : (options.scopes || [
      { category: "linear", settleCoin: "USDT" },
      { category: "linear", settleCoin: "USDC" },
      { category: "inverse" },
      { category: "option" }
    ]);
  const records = [];

  for (const scope of scopes) {
    const seenCursors = new Set();
    let cursor;
    let pages = 0;
    do {
      const cursorKey = cursor || "__FIRST_PAGE__";
      if (seenCursors.has(cursorKey)) {
        throw Object.assign(new Error(`Bybit position pagination repeated a cursor for ${scope.category}.`), { code: "BROKER_PAGINATION_INVALID", statusCode: 502 });
      }
      seenCursors.add(cursorKey);
      const response = await bybitRequest(credentials, "GET", "/v5/position/list", {
        category: scope.category,
        symbol: scope.symbol,
        settleCoin: scope.settleCoin,
        baseCoin: scope.baseCoin,
        cursor,
        limit: "200"
      });
      for (const raw of response?.list || []) records.push(normalizeBybitPosition(raw, scope.category));
      cursor = response?.nextPageCursor || undefined;
      pages += 1;
      if (cursor && pages >= maxPages) {
        throw Object.assign(new Error(`Bybit position pagination exceeded ${maxPages} pages for ${scope.category}.`), { code: "BROKER_PAGINATION_LIMIT", statusCode: 502 });
      }
    } while (cursor);
  }

  const unique = new Map();
  for (const position of records) {
    if (!options.includeEmpty && (position.quantity <= 0 || position.direction === "flat")) continue;
    const key = `${position.category}:${position.symbol}:${position.positionIdx}:${position.direction}`;
    const current = unique.get(key);
    if (!current || position.updatedAt >= current.updatedAt) unique.set(key, position);
  }
  return Array.from(unique.values());
}

export function normalizeBybitPosition(position, category = "linear") {
  const quantity = Number(position?.size || 0);
  const direction = position?.side === "Sell" ? "short" : position?.side === "Buy" ? "long" : "flat";
  const positionIdx = Number(position?.positionIdx || 0);
  return {
    category,
    marketKind: category === "option" ? "option" : "perpetual",
    symbol: String(position?.symbol || "").toUpperCase(),
    direction,
    quantity,
    averagePrice: Number(position?.avgPrice || 0),
    currentPrice: Number(position?.markPrice || 0),
    unrealizedPnl: Number(position?.unrealisedPnl || 0),
    realizedPnl: Number(position?.cumRealisedPnl || 0),
    margin: Number(position?.positionIM || position?.positionValue || 0),
    leverage: Number(position?.leverage || 1),
    liquidationPrice: nullableNumber(position?.liqPrice),
    stopLoss: nullableNumber(position?.stopLoss),
    takeProfit: nullableNumber(position?.takeProfit),
    trailingStop: nullableNumber(position?.trailingStop),
    positionIdx,
    positionMode: positionIdx === 0 ? "one-way" : "hedge",
    marginMode: Number(position?.tradeMode || 0) === 1 ? "isolated" : "cross",
    riskId: Number(position?.riskId || 0),
    positionValue: Number(position?.positionValue || 0),
    openedAt: Number(position?.createdTime || position?.updatedTime || Date.now()),
    updatedAt: Number(position?.updatedTime || position?.createdTime || Date.now())
  };
}

async function bybitRequest(credentials, method, path, query = {}, body) {
  const maxRetries = method === "GET" ? 1 : 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await waitForBybitRequestSlot(credentials);
    try {
      return await bybitRequestOnce(credentials, method, path, query, body);
    } catch (error) {
      if (error?.code !== "RATE_LIMITED" || attempt >= maxRetries) throw error;
      const retryAfterMs = Math.max(50, Math.min(1000, Number(error?.publicDetails?.retryAfterMs || 250)));
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    }
  }
  throw Object.assign(new Error("Bybit request retry policy exhausted."), { code: "RATE_LIMITED", statusCode: 429 });
}

async function bybitRequestOnce(credentials, method, path, query = {}, body) {
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
  }, credentials);

  const data = await readBybitResponse(response);

  if (!response.ok || data?.retCode !== 0) {
    const bybitCode = data?.retCode;
    const bybitMessage = String(data?.retMsg || "").trim();
    const regionalMessage = response.status === 403
      ? `Bybit rejected the request from server region ${BYBIT_RUNTIME_REGION} (HTTP 403). The execution backend must run outside Bybit-restricted regions.`
      : "";
    const error = new Error(regionalMessage || bybitMessage || `Bybit request failed${bybitCode !== undefined ? ` with retCode ${bybitCode}` : ""} at ${path} (HTTP ${response.status})`);
    const normalized = normalizeBybitError(bybitCode, bybitMessage, response.status);
    error.statusCode = normalized.statusCode;
    error.code = normalized.code;
    error.publicDetails = {
      endpoint: path,
      retryAfterMs: bybitRetryAfterMs(response),
      rateLimitRemaining: response.headers.get("X-Bapi-Limit-Status"),
      rateLimit: response.headers.get("X-Bapi-Limit")
    };
    error.bybit = data;
    error.bybitEndpoint = path;
    error.bybitHttpStatus = response.status;
    error.bybitBaseUrl = baseUrl;
    error.runtimeRegion = BYBIT_RUNTIME_REGION;
    throw error;
  }

  return data.result;
}

async function waitForBybitRequestSlot(credentials) {
  const key = crypto.createHash("sha256").update(String(credentials?.apiKey || "anonymous")).digest("hex").slice(0, 16);
  const previous = bybitRequestStartGates.get(key) || Promise.resolve();
  const gate = previous.catch(() => undefined).then(async () => {
    const lastStartedAt = Number(gate.lastStartedAt || bybitRequestStartGates.get(`${key}:time`) || 0);
    const waitMs = Math.max(0, BYBIT_MIN_REQUEST_SPACING_MS - (Date.now() - lastStartedAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    bybitRequestStartGates.set(`${key}:time`, Date.now());
  });
  bybitRequestStartGates.set(key, gate);
  await gate;
  if (bybitRequestStartGates.get(key) === gate) bybitRequestStartGates.delete(key);
}

export function normalizeBybitError(code, message, httpStatus) {
  const numericCode = Number(code);
  const text = String(message || "").toLowerCase();
  if (numericCode === 10003) return { code: "INVALID_API_KEY", statusCode: 401 };
  if (numericCode === 10004) return { code: "INVALID_SIGNATURE", statusCode: 401 };
  if (numericCode === 10005) return { code: "INSUFFICIENT_PERMISSIONS", statusCode: 403 };
  if (numericCode === 10006 || httpStatus === 429) return { code: "RATE_LIMITED", statusCode: 429 };
  if (numericCode === 10010 || text.includes("unmatched ip") || /\bip (?:address|restriction|allowlist)\b/.test(text)) return { code: "IP_RESTRICTION", statusCode: 403 };
  if (text.includes("expired")) return { code: "TOKEN_EXPIRED", statusCode: 401 };
  if (httpStatus === 403) return { code: "BROKER_REGION_RESTRICTED", statusCode: 503 };
  return { code: "BROKER_UNAVAILABLE", statusCode: httpStatus === 401 ? 401 : 502 };
}

function bybitRetryAfterMs(response) {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(response.headers.get("X-Bapi-Limit-Reset-Timestamp"));
  return Number.isFinite(reset) && reset > Date.now() ? reset - Date.now() : null;
}

export async function getBybitApiKeyInformation(credentials) {
  const endpointSet = resolveBybitEndpointSet(credentials);
  const cacheKey = crypto.createHash("sha256")
    .update(`${endpointSet.environment}:${endpointSet.region}:${String(credentials.apiKey || "")}`)
    .digest("hex")
    .slice(0, 24);
  const cached = bybitPermissionCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < 60_000) return cached.value;
  const value = await bybitRequest(credentials, "GET", "/v5/user/query-api", {});
  bybitPermissionCache.set(cacheKey, { storedAt: Date.now(), value });
  return value;
}

async function bybitPublicRequest(path, query = {}, routing = {}) {
  const queryString = buildQueryString(query);
  const { response, baseUrl } = await fetchBybitWithFallback(path, queryString, {
    headers: {
      "cdn-request-id": createBybitRequestId()
    }
  }, { ...routing, publicData: true });
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
    wrapped.code = timedOut ? "NETWORK_TIMEOUT" : "BROKER_UNAVAILABLE";
    wrapped.bybitEndpoint = endpoint;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBybitWithFallback(path, queryString, options, routing = {}) {
  const baseUrls = getBybitBaseUrls(routing);
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

function getBybitBaseUrls(routing = {}) {
  if (routing.baseUrl) {
    throw Object.assign(new Error("Per-request Bybit baseUrl overrides are forbidden. Select a certified execution environment and endpoint profile."), { code: "BYBIT_ENDPOINT_OVERRIDE_REJECTED", statusCode: 400 });
  }
  const endpointSet = resolveBybitEndpointSet({
    executionEnvironment: routing.executionEnvironment ?? routing.environment ?? routing.network ?? process.env.BYBIT_EXECUTION_ENVIRONMENT ?? process.env.BLACK_CLOUD_EXECUTION_ENVIRONMENT,
    endpointProfile: routing.endpointProfile ?? routing.region ?? process.env.BYBIT_ENDPOINT_PROFILE ?? "GLOBAL"
  });
  return [routing.publicData ? endpointSet.publicRest : endpointSet.rest];
}

export function resolveBybitBaseUrlsForTests(routing = {}) { return getBybitBaseUrls(routing); }

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
  // Bybit reports an IOC that received a partial fill and then expired as
  // `PartiallyFilledCanceled`.  It is terminal: treating it as the generic
  // non-terminal `PartiallyFilled` state leaves dependent TP commands waiting
  // forever even though the final cumulative fill is already known.
  if (value.includes("partiallyfilled") && value.includes("cancel")) return "cancelled";
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
  const options = normalizePermissionList(permissions.Options || permissions.options || []);
  const wallet = normalizePermissionList(permissions.Wallet || permissions.wallet || []);
  const contractOrder = contract.includes("order") || contract.includes("derivativestrade");
  const contractPosition = contract.includes("position") || contract.includes("derivativestrade");
  const spotTrade = spot.includes("spottrade") || spot.includes("trade");
  const optionsTrade = options.includes("optionstrade") || options.includes("trade");
  const trading = !readOnly && contractOrder && contractPosition;
  const withdrawal = wallet.some((item) => ["withdraw", "withdrawal"].includes(item));
  const transfer = wallet.some((item) => ["accounttransfer", "submembertransfer", "submembertransferlist", "transfer"].includes(item));
  const warnings = [];

  if (readOnly) warnings.push("Bybit API key is read-only.");
  if (!contractOrder) warnings.push("Bybit API key lacks ContractTrade.Order permission.");
  if (!contractPosition) warnings.push("Bybit API key lacks ContractTrade.Position permission.");
  if (transfer) warnings.push("Wallet transfer permission detected. Create a trading-only key without AccountTransfer or SubMemberTransfer.");
  if (withdrawal) warnings.push("Withdrawal permission detected. Use trading-only API keys.");
  if (apiKeyInfo.error) warnings.push(`Bybit API-key permission probe failed: ${apiKeyInfo.error}`);

  const snapshot = Object.freeze({
    readOnly,
    contractOrder,
    contractPosition,
    spotTrade,
    optionsTrade,
    walletTransfer: transfer,
    withdrawal,
    verifiedAt: Date.now()
  });

  return {
    read: true,
    trading,
    withdrawal,
    transfer,
    accountUid: String(apiKeyInfo.userID ?? apiKeyInfo.userId ?? ""),
    snapshot,
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
