import crypto from "node:crypto";

const BYBIT_BASE_URL = process.env.BYBIT_BASE_URL || "https://api.bybit.com";
const RECV_WINDOW = "5000";

export async function validateBybitCredentials(credentials) {
  const startedAt = Date.now();
  const diagnostics = await getBybitDiagnostics(credentials, { symbol: "BTCUSDT" });

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
  const [time, metadata, balances, positions, openOrders] = await Promise.all([
    getBybitServerTime(),
    getBybitInstrumentMetadata({ category: "linear", symbol }),
    getBybitBalances(credentials),
    getBybitPositions(credentials),
    getBybitOpenOrders(credentials, { category: "linear", symbol })
  ]);

  return {
    venueId: "bybit",
    provider: "bybit",
    network: "mainnet",
    executionMode: "read-only",
    readiness: "connected-read-only",
    latencyMs: Date.now() - startedAt,
    authentication: "authenticated",
    synchronization: "synced",
    publicStream: "connected",
    privateStream: "not-supported",
    permissions: {
      read: true,
      trading: false,
      withdrawal: false,
      warnings: ["Bybit trading remains disabled until private stream, precision, execution, cancel/modify, reconciliation, and mainnet validation certification are complete."]
    },
    time,
    metadata,
    balances,
    positions,
    openOrders,
    rateLimitUsage: "unknown",
    certification: {
      marketDataReady: true,
      authReady: true,
      accountReadReady: true,
      balancesReady: true,
      positionsReady: true,
      openOrdersReady: true,
      privateStreamsReady: false,
      executionReady: false,
      mainnetValidated: false
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
  const category = order.marketKind === "spot" ? "spot" : "linear";
  const orderType = normalizeBybitOrderType(order.orderType);
  const body = {
    category,
    symbol: order.symbol,
    side: order.side === "buy" ? "Buy" : "Sell",
    orderType,
    qty: String(order.quantity),
    timeInForce: normalizeBybitTimeInForce(order.timeInForce)
  };

  if (orderType === "Limit" && order.limitPrice) {
    body.price = String(order.limitPrice);
  }

  if (order.stopPrice) {
    body.triggerPrice = String(order.stopPrice);
    body.triggerDirection = Number(order.stopPrice) >= Number(order.referencePrice || order.limitPrice || 0) ? 1 : 2;
  }

  if (order.takeProfit) {
    body.takeProfit = String(order.takeProfit);
  }

  if (order.stopLoss) {
    body.stopLoss = String(order.stopLoss);
  }

  if (category !== "spot" && order.reduceOnly) {
    body.reduceOnly = true;
  }

  const response = await bybitRequest(credentials, "POST", "/v5/order/create", {}, body);
  return {
    exchangeOrderId: response?.orderId,
    clientOrderId: response?.orderLinkId
  };
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
  return {
    exchangeOrderId: response?.orderId || orderId,
    clientOrderId: response?.orderLinkId || clientOrderId
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
  return {
    exchangeOrderId: response?.orderId || patch.orderId,
    clientOrderId: response?.orderLinkId || patch.clientOrderId
  };
}

async function getBybitBalances(credentials) {
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

async function getBybitPositions(credentials) {
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
    const error = new Error(data?.retMsg || `Bybit request failed with HTTP ${response.status}`);
    error.statusCode = response.status === 401 ? 401 : 502;
    error.bybit = data;
    throw error;
  }

  return data.result;
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

function normalizeBybitOrderType(orderType) {
  if (orderType === "market") return "Market";
  if (orderType === "stop-market") return "Market";
  if (["trailing-stop", "twap", "iceberg"].includes(orderType)) {
    throw new Error(`${orderType} execution algorithm is not configured for Bybit yet.`);
  }
  return "Limit";
}

function normalizeBybitTimeInForce(timeInForce) {
  if (timeInForce === "ioc") return "IOC";
  if (timeInForce === "fok") return "FOK";
  return "GTC";
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function precisionFromStep(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!text.includes(".")) return 0;
  return text.split(".")[1].replace(/0+$/, "").length;
}

function normalizeBybitOrderStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("filled")) return "filled";
  if (value.includes("cancel")) return "cancelled";
  if (value.includes("reject")) return "rejected";
  if (value.includes("new") || value.includes("created")) return "accepted";
  return value || "pending";
}
