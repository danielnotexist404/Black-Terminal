import crypto from "node:crypto";

const BYBIT_BASE_URL = process.env.BYBIT_BASE_URL || "https://api.bybit.com";
const RECV_WINDOW = "5000";

export async function validateBybitCredentials(credentials) {
  const startedAt = Date.now();
  await bybitRequest(credentials, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });

  return {
    status: "connected",
    apiHealth: "healthy",
    latencyMs: Date.now() - startedAt
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
