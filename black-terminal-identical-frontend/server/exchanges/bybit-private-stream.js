import crypto from "node:crypto";

const BYBIT_PRIVATE_TOPICS = ["order", "execution", "position", "wallet", "strategy"];
const DEFAULT_STALE_AFTER_MS = 45_000;
const DEFAULT_PING_MS = 20_000;

const runtimeState = {
  enabled: process.env.BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED === "true",
  status: process.env.BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED === "true" ? "disconnected" : "not-supported",
  authenticated: false,
  reconnectCount: 0,
  subscriptionCount: 0,
  topics: [],
  lastMessageAt: null,
  lastOrderAt: null,
  lastExecutionAt: null,
  lastPositionAt: null,
  lastWalletAt: null,
  lastStrategyAt: null,
  lastError: process.env.BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED === "true"
    ? null
    : "BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED is not true. Persistent private streams require a long-running worker runtime."
};

export function getBybitPrivateWsUrl({ network = "mainnet" } = {}) {
  if (process.env.BYBIT_PRIVATE_WS_URL) return process.env.BYBIT_PRIVATE_WS_URL;
  return network === "testnet" || network === "sandbox"
    ? "wss://stream-testnet.bybit.com/v5/private"
    : "wss://stream.bybit.com/v5/private";
}

export function createBybitWsAuthPayload(credentials, { expires = Date.now() + 10_000 } = {}) {
  const signature = crypto
    .createHmac("sha256", credentials.apiSecret)
    .update(`GET/realtime${expires}`)
    .digest("hex");

  return {
    op: "auth",
    args: [credentials.apiKey, expires, signature]
  };
}

export function getBybitPrivateStreamRuntimeDiagnostics() {
  const now = Date.now();
  const lastMessageAt = runtimeState.lastMessageAt ? Number(runtimeState.lastMessageAt) : null;
  const stale = lastMessageAt ? now - lastMessageAt > DEFAULT_STALE_AFTER_MS : runtimeState.status === "connected";

  return {
    ...runtimeState,
    status: stale ? "stale" : runtimeState.status,
    stale,
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    lastMessageAgeMs: lastMessageAt ? now - lastMessageAt : null
  };
}

export function normalizeBybitPrivateStreamMessage(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  if (!payload || typeof payload !== "object") return [];
  if (payload.op === "pong" || payload.ret_msg === "pong") return [];

  const topic = String(payload.topic || "");
  const rows = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
  const time = Number(payload.creationTime || payload.ts || Date.now());

  if (topic.startsWith("order")) {
    return rows.map((row) => ({
      type: "order",
      topic,
      time,
      report: normalizeBybitOrderEvent(row, time),
      raw: row
    }));
  }

  if (topic.startsWith("execution")) {
    return rows.map((row) => ({
      type: "execution",
      topic,
      time,
      fill: normalizeBybitExecutionEvent(row, time),
      raw: row
    }));
  }

  if (topic.startsWith("position")) {
    return rows.map((row) => ({
      type: "position",
      topic,
      time,
      position: normalizeBybitPositionEvent(row, time),
      raw: row
    }));
  }

  if (topic.startsWith("wallet")) {
    return rows.flatMap((row) => normalizeBybitWalletEvent(row, time).map((wallet) => ({
      type: "wallet",
      topic,
      time,
      wallet,
      raw: row
    })));
  }

  if (topic.startsWith("strategy")) {
    return rows.map((row) => ({
      type: "strategy",
      topic,
      time,
      strategy: normalizeBybitStrategyEvent(row, time),
      raw: row
    }));
  }

  return [];
}

export class BybitPrivateStreamClient {
  constructor(credentials, options = {}) {
    this.credentials = credentials;
    this.network = options.network || "mainnet";
    this.url = options.url || getBybitPrivateWsUrl({ network: this.network });
    this.topics = options.topics || BYBIT_PRIVATE_TOPICS;
    this.handlers = new Set();
    this.errorHandlers = new Set();
    this.reconnectDelayMs = options.reconnectDelayMs || 1_500;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs || 30_000;
    this.pingIntervalMs = options.pingIntervalMs || DEFAULT_PING_MS;
    this.staleAfterMs = options.staleAfterMs || DEFAULT_STALE_AFTER_MS;
    this.WebSocketCtor = options.WebSocketCtor;
    this.ws = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.staleTimer = null;
    this.closedByUser = false;
  }

  onMessage(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onError(handler) {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  async connect() {
    runtimeState.enabled = true;
    runtimeState.status = "connecting";
    runtimeState.lastError = null;
    this.closedByUser = false;
    const WebSocketCtor = await this.resolveWebSocketCtor();
    this.ws = new WebSocketCtor(this.url);
    this.bindSocket(this.ws);
    return this;
  }

  disconnect() {
    this.closedByUser = true;
    this.clearTimers();
    runtimeState.status = "disconnected";
    runtimeState.authenticated = false;
    if (this.ws) this.ws.close?.();
  }

  diagnostics() {
    return getBybitPrivateStreamRuntimeDiagnostics();
  }

  async resolveWebSocketCtor() {
    if (this.WebSocketCtor) return this.WebSocketCtor;
    if (globalThis.WebSocket) return globalThis.WebSocket;
    const mod = await import("ws");
    return mod.WebSocket || mod.default;
  }

  bindSocket(ws) {
    const handleOpen = () => {
      runtimeState.status = "authenticating";
      this.send(createBybitWsAuthPayload(this.credentials));
      this.startTimers();
    };
    const handleMessage = (data) => this.handleRawMessage(typeof data === "string" ? data : data?.toString?.() ?? String(data));
    const handleError = (error) => this.handleError(error);
    const handleClose = () => {
      runtimeState.authenticated = false;
      runtimeState.status = this.closedByUser ? "disconnected" : "reconnecting";
      this.clearTimers();
      if (!this.closedByUser) this.scheduleReconnect();
    };

    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", handleOpen);
      ws.addEventListener("message", (event) => handleMessage(event.data));
      ws.addEventListener("error", handleError);
      ws.addEventListener("close", handleClose);
      return;
    }

    ws.on("open", handleOpen);
    ws.on("message", handleMessage);
    ws.on("error", handleError);
    ws.on("close", handleClose);
  }

  handleRawMessage(raw) {
    runtimeState.lastMessageAt = Date.now();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      this.handleError(error);
      return;
    }

    if (payload.op === "auth") {
      if (payload.success === true || payload.retCode === 0) {
        runtimeState.authenticated = true;
        runtimeState.status = "connected";
        this.subscribe(this.topics);
      } else {
        this.handleError(new Error(payload.ret_msg || payload.retMsg || "Bybit private stream authentication failed."));
      }
      return;
    }

    const events = normalizeBybitPrivateStreamMessage(payload);
    for (const event of events) {
      if (event.type === "order") runtimeState.lastOrderAt = event.time;
      if (event.type === "execution") runtimeState.lastExecutionAt = event.time;
      if (event.type === "position") runtimeState.lastPositionAt = event.time;
      if (event.type === "wallet") runtimeState.lastWalletAt = event.time;
      if (event.type === "strategy") runtimeState.lastStrategyAt = event.time;
      for (const handler of this.handlers) handler(event);
    }
  }

  subscribe(topics) {
    const uniqueTopics = [...new Set(topics)];
    runtimeState.topics = uniqueTopics;
    runtimeState.subscriptionCount = uniqueTopics.length;
    this.send({ op: "subscribe", args: uniqueTopics });
  }

  send(payload) {
    if (!this.ws) return;
    const serialized = JSON.stringify(payload);
    if (this.ws.readyState === 1 || this.ws.readyState === this.ws.OPEN) {
      this.ws.send(serialized);
    }
  }

  startTimers() {
    this.clearTimers();
    this.pingTimer = setInterval(() => this.send({ op: "ping" }), this.pingIntervalMs);
    this.staleTimer = setInterval(() => {
      const lastMessageAt = runtimeState.lastMessageAt ? Number(runtimeState.lastMessageAt) : 0;
      if (runtimeState.status === "connected" && lastMessageAt && Date.now() - lastMessageAt > this.staleAfterMs) {
        this.handleError(new Error("Bybit private stream stale threshold exceeded."));
        this.ws?.close?.();
      }
    }, Math.max(5_000, Math.floor(this.staleAfterMs / 3)));
  }

  clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.staleTimer = null;
    this.reconnectTimer = null;
  }

  scheduleReconnect() {
    runtimeState.reconnectCount += 1;
    const delay = Math.min(this.maxReconnectDelayMs, this.reconnectDelayMs * 2 ** Math.max(0, runtimeState.reconnectCount - 1));
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  handleError(error) {
    const nextError = error instanceof Error ? error : new Error(String(error));
    runtimeState.lastError = nextError.message;
    runtimeState.status = runtimeState.status === "connected" ? "degraded" : runtimeState.status;
    for (const handler of this.errorHandlers) handler(nextError);
  }
}

function normalizeBybitOrderEvent(row, time) {
  const status = normalizeBybitOrderStatus(row.orderStatus);
  return {
    exchange: "bybit",
    orderId: row.orderId,
    exchangeOrderId: row.orderId,
    clientOrderId: row.orderLinkId || undefined,
    symbol: row.symbol,
    status,
    side: String(row.side || "").toLowerCase() === "sell" ? "sell" : "buy",
    orderType: String(row.orderType || "").toLowerCase(),
    quantity: Number(row.qty || 0),
    filledQuantity: Number(row.cumExecQty || 0),
    averageFillPrice: nullableNumber(row.avgPrice),
    price: nullableNumber(row.price),
    reduceOnly: Boolean(row.reduceOnly),
    rejectReason: row.rejectReason || undefined,
    time
  };
}

function normalizeBybitExecutionEvent(row, time) {
  return {
    exchange: "bybit",
    fillId: row.execId,
    orderId: row.orderId,
    clientOrderId: row.orderLinkId || undefined,
    symbol: row.symbol,
    side: String(row.side || "").toLowerCase() === "sell" ? "sell" : "buy",
    price: Number(row.execPrice || 0),
    quantity: Number(row.execQty || 0),
    fee: Number(row.execFee || 0),
    feeAsset: row.feeCurrency || row.execFeeCurrency || undefined,
    liquidity: row.isMaker === true ? "maker" : row.isMaker === false ? "taker" : undefined,
    time: Number(row.execTime || time)
  };
}

function normalizeBybitPositionEvent(row, time) {
  const quantity = Number(row.size || 0);
  return {
    exchange: "bybit",
    symbol: row.symbol,
    direction: row.side === "Sell" ? "short" : row.side === "Buy" ? "long" : "flat",
    quantity,
    averagePrice: Number(row.entryPrice || row.avgPrice || 0),
    currentPrice: Number(row.markPrice || 0),
    unrealizedPnl: Number(row.unrealisedPnl || 0),
    realizedPnl: Number(row.cumRealisedPnl || 0),
    leverage: Number(row.leverage || 1),
    liquidationPrice: nullableNumber(row.liqPrice),
    takeProfit: nullableNumber(row.takeProfit),
    stopLoss: nullableNumber(row.stopLoss),
    trailingStop: nullableNumber(row.trailingStop),
    updatedAt: Number(row.updatedTime || time)
  };
}

function normalizeBybitWalletEvent(row, time) {
  const coins = Array.isArray(row.coin) ? row.coin : [];
  return coins.map((coin) => {
    const total = Number(coin.walletBalance || 0);
    const locked = Number(coin.locked || 0);
    return {
      exchange: "bybit",
      accountType: row.accountType || "UNIFIED",
      asset: coin.coin,
      total,
      locked,
      free: Math.max(0, total - locked),
      usdValue: Number(coin.usdValue || 0),
      updatedAt: time
    };
  });
}

function normalizeBybitStrategyEvent(row, time) {
  const statusMap = { 2: "working", 3: "filled", 4: "cancelled", 5: "paused", 6: "pending" };
  return {
    exchange: "bybit",
    strategyId: row.strategyId,
    strategyType: row.strategyType,
    symbol: row.symbol,
    side: String(row.side || "").toLowerCase() === "sell" ? "sell" : "buy",
    status: statusMap[Number(row.status)] || "pending",
    quantity: Number(row.size || 0),
    filledQuantity: Number(row.executedSize || 0),
    averageFillPrice: nullableNumber(row.executedAvgPrice),
    reduceOnly: Boolean(row.reduceOnly),
    terminateType: Number(row.terminateType || 0),
    reason: row.terminateRemark || undefined,
    updatedAt: Number(row.updatedTimeE3 || time)
  };
}

function normalizeBybitOrderStatus(status) {
  const value = String(status || "").replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (value.includes("partiallyfilled")) return "partially-filled";
  if (value.includes("filled")) return "filled";
  if (value.includes("cancel")) return "cancelled";
  if (value.includes("reject")) return "rejected";
  if (value.includes("deactivated")) return "cancelled";
  if (value.includes("untriggered") || value.includes("triggered")) return "working";
  if (value.includes("new") || value.includes("created")) return "working";
  return value || "pending";
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
