import crypto from "node:crypto";
import { HttpTransport } from "@nktkas/hyperliquid";
import { cancel, cancelByCloid, modify, order, updateLeverage } from "@nktkas/hyperliquid/api/exchange";
import { allMids, clearinghouseState, extraAgents, meta, openOrders, userFills } from "@nktkas/hyperliquid/api/info";
import { privateKeyToAccount } from "viem/accounts";

const NETWORKS = new Set(["mainnet", "testnet"]);
const MAINNET_URL = "https://api.hyperliquid.xyz";
const TESTNET_URL = "https://api.hyperliquid-testnet.xyz";
const metadataCache = new Map();

export const HYPERLIQUID_CAPABILITIES = [
  "market-orders",
  "limit-orders",
  "conditional-orders",
  "perpetual-orders",
  "modify-orders",
  "cancel-orders",
  "leverage",
  "cross-margin",
  "isolated-margin",
  "funding",
  "liquidation",
  "reduce-only",
  "post-only",
  "balances",
  "positions",
  "orders",
  "trades",
  "wallet-connect",
  "transaction-signing",
  "public-websocket"
];

export function normalizeHyperliquidNetwork(value) {
  const network = String(value || process.env.HYPERLIQUID_NETWORK || "testnet").toLowerCase();
  if (!NETWORKS.has(network)) {
    const error = new Error("Invalid Hyperliquid network. Use mainnet or testnet.");
    error.statusCode = 400;
    throw error;
  }
  return network;
}

export function assertHyperliquidRelayConfigured(options = {}) {
  const network = options.network ? normalizeHyperliquidNetwork(options.network) : null;
  if (process.env.HYPERLIQUID_RELAY_ENABLED !== "true") {
    const error = new Error("Hyperliquid relay is disabled. Set HYPERLIQUID_RELAY_ENABLED=true after testnet validation.");
    error.statusCode = 503;
    throw error;
  }

  getHyperliquidEncryptionKey();

  if (network === "mainnet") {
    if (process.env.HYPERLIQUID_MAINNET_ENABLED !== "true") {
      const error = new Error("Hyperliquid mainnet relay is disabled. Set HYPERLIQUID_MAINNET_ENABLED=true only after testnet validation.");
      error.statusCode = 403;
      throw error;
    }
    if (options.mainnetConfirmed !== true) {
      const error = new Error("Mainnet Hyperliquid execution requires explicit user confirmation.");
      error.statusCode = 400;
      throw error;
    }
  }
}

export function getHyperliquidTransport(network) {
  return new HttpTransport({
    isTestnet: network === "testnet",
    apiUrl: network === "testnet"
      ? process.env.HYPERLIQUID_TESTNET_API_URL || TESTNET_URL
      : process.env.HYPERLIQUID_API_URL || MAINNET_URL,
    timeout: Number(process.env.HYPERLIQUID_HTTP_TIMEOUT_MS || 10000)
  });
}

export function normalizePrivateKey(value) {
  const key = String(value || "").trim();
  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    const error = new Error("Invalid Hyperliquid agent private key format.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export function normalizeAddress(value, label = "address") {
  const address = String(value || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    const error = new Error(`Invalid Hyperliquid ${label}.`);
    error.statusCode = 400;
    throw error;
  }
  return address;
}

export function deriveAgentAddress(agentPrivateKey) {
  return privateKeyToAccount(normalizePrivateKey(agentPrivateKey)).address.toLowerCase();
}

export function encryptHyperliquidCredentialPayload(payload) {
  const key = getHyperliquidEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    version: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64")
  });
}

export function decryptHyperliquidCredentialPayload(encryptedPayload) {
  const key = getHyperliquidEncryptionKey();
  const payload = JSON.parse(encryptedPayload);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

export async function getHyperliquidMetadata(network) {
  const key = network;
  const cached = metadataCache.get(key);
  if (cached && Date.now() - cached.loadedAt < 60000) return cached;

  const transport = getHyperliquidTransport(network);
  const data = await meta({ transport });
  const assets = data.universe.map((asset, index) => ({
    ...asset,
    assetId: index,
    symbol: `${asset.name}USDT`,
    minNotional: 10,
    priceMaxDecimals: Math.max(0, 6 - Number(asset.szDecimals || 0))
  }));
  const next = {
    loadedAt: Date.now(),
    network,
    raw: data,
    assets,
    byCoin: new Map(assets.map((asset) => [asset.name.toUpperCase(), asset])),
    bySymbol: new Map(assets.map((asset) => [asset.symbol.toUpperCase(), asset]))
  };
  metadataCache.set(key, next);
  return next;
}

export async function validateHyperliquidAgent({ network, masterWalletAddress, agentWalletAddress }) {
  const master = normalizeAddress(masterWalletAddress, "master wallet address");
  const agent = normalizeAddress(agentWalletAddress, "agent wallet address");
  const transport = getHyperliquidTransport(network);
  const startedAt = Date.now();

  const [agents, state, metadata] = await Promise.all([
    extraAgents({ transport }, { user: master }),
    clearinghouseState({ transport }, { user: master }),
    getHyperliquidMetadata(network)
  ]);
  const matchedAgent = agents.find((item) => String(item.address).toLowerCase() === agent);
  const expired = matchedAgent?.validUntil !== null && Number(matchedAgent?.validUntil || 0) <= Date.now();
  const executionReady = Boolean(matchedAgent && !expired);
  const readinessReason = executionReady
    ? "Hyperliquid agent wallet is authorized and metadata is loaded."
    : matchedAgent
      ? "Hyperliquid agent wallet authorization is expired."
      : "Hyperliquid agent wallet is not approved by the connected master wallet.";

  return {
    executionReady,
    readinessReason,
    matchedAgent: matchedAgent || null,
    accountState: state,
    metadata,
    latencyMs: Date.now() - startedAt
  };
}

export async function loadHyperliquidCredential(supabase, userId, selector) {
  let query = supabase
    .from("hyperliquid_credentials")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);

  if (selector.credentialId) query = query.eq("id", selector.credentialId);
  if (selector.accountId) query = query.eq("account_id", selector.accountId);
  if (selector.connectionId) query = query.eq("connection_id", selector.connectionId);

  const { data, error } = await query.maybeSingle();
  if (error || !data) {
    const notFound = new Error("Hyperliquid execution credential not found or inactive.");
    notFound.statusCode = 404;
    throw notFound;
  }

  return data;
}

export async function submitHyperliquidOrder(supabase, userId, credential, draft) {
  assertHyperliquidRelayConfigured({ network: credential.network, mainnetConfirmed: draft.mainnetConfirmed });
  const startedAt = Date.now();
  const network = normalizeHyperliquidNetwork(credential.network);
  const privatePayload = decryptHyperliquidCredentialPayload(credential.encrypted_agent_private_key);
  const wallet = privateKeyToAccount(normalizePrivateKey(privatePayload.agentPrivateKey));
  const transport = getHyperliquidTransport(network);
  const exchangeConfig = createExchangeConfig({ supabase, userId, credential, wallet, transport });
  const prepared = await prepareHyperliquidOrder(network, draft);

  if (draft.leverage && !draft.reduceOnly) {
    await updateLeverage(exchangeConfig, {
      asset: prepared.asset.assetId,
      isCross: draft.marginMode !== "isolated",
      leverage: Math.max(1, Math.min(prepared.asset.maxLeverage, Number(draft.leverage)))
    });
  }

  await writeHyperliquidRelayEvent(supabase, {
    userId,
    accountId: draft.accountId,
    connectionId: credential.connection_id,
    credentialId: credential.id,
    eventType: "order_signed",
    severity: "info",
    symbol: draft.symbol,
    clientOrderId: prepared.order.c,
    message: "Hyperliquid order payload signed by server-side agent wallet.",
    metadata: { network, assetId: prepared.asset.assetId, orderType: draft.orderType || draft.type }
  });

  const response = await order(exchangeConfig, {
    orders: [prepared.order],
    grouping: prepared.grouping
  });
  const normalized = normalizeOrderResponse(response, draft, prepared, Date.now() - startedAt);
  await markCredentialUsed(supabase, credential.id);
  return normalized;
}

export async function cancelHyperliquidOrder(supabase, userId, credential, draft) {
  assertHyperliquidRelayConfigured({ network: credential.network, mainnetConfirmed: draft.mainnetConfirmed });
  const startedAt = Date.now();
  const network = normalizeHyperliquidNetwork(credential.network);
  const privatePayload = decryptHyperliquidCredentialPayload(credential.encrypted_agent_private_key);
  const wallet = privateKeyToAccount(normalizePrivateKey(privatePayload.agentPrivateKey));
  const transport = getHyperliquidTransport(network);
  const exchangeConfig = createExchangeConfig({ supabase, userId, credential, wallet, transport });
  const asset = await resolveHyperliquidAsset(network, draft.symbol);
  const clientOrderId = draft.clientOrderId ? normalizeClientOrderId(draft.clientOrderId) : null;

  const response = clientOrderId
    ? await cancelByCloid(exchangeConfig, { cancels: [{ asset: asset.assetId, cloid: clientOrderId }] })
    : await cancel(exchangeConfig, { cancels: [{ a: asset.assetId, o: Number(draft.orderId) }] });
  const status = response.response.data.statuses[0];
  const rejected = typeof status === "object" && status?.error;
  await markCredentialUsed(supabase, credential.id);

  return {
    accountId: draft.accountId,
    exchange: "hyperliquid",
    orderId: draft.orderId || draft.clientOrderId,
    clientOrderId: draft.clientOrderId,
    symbol: draft.symbol,
    status: rejected ? "rejected" : "cancelled",
    filledQuantity: 0,
    reason: rejected ? status.error : undefined,
    time: Date.now(),
    latencyMs: Date.now() - startedAt,
    rawResponse: sanitizeRawResponse(response)
  };
}

export async function modifyHyperliquidOrder(supabase, userId, credential, draft) {
  assertHyperliquidRelayConfigured({ network: credential.network, mainnetConfirmed: draft.mainnetConfirmed });
  const startedAt = Date.now();
  const network = normalizeHyperliquidNetwork(credential.network);
  const privatePayload = decryptHyperliquidCredentialPayload(credential.encrypted_agent_private_key);
  const wallet = privateKeyToAccount(normalizePrivateKey(privatePayload.agentPrivateKey));
  const transport = getHyperliquidTransport(network);
  const exchangeConfig = createExchangeConfig({ supabase, userId, credential, wallet, transport });
  const prepared = await prepareHyperliquidOrder(network, draft);
  const oid = draft.clientOrderId ? normalizeClientOrderId(draft.clientOrderId) : Number(draft.orderId);

  const response = await modify(exchangeConfig, {
    oid,
    order: prepared.order
  });
  await markCredentialUsed(supabase, credential.id);

  return {
    accountId: draft.accountId,
    exchange: "hyperliquid",
    orderId: draft.orderId,
    clientOrderId: draft.clientOrderId,
    symbol: draft.symbol,
    status: response.status === "ok" ? "accepted" : "rejected",
    filledQuantity: 0,
    reason: response.status === "ok" ? undefined : response.response,
    time: Date.now(),
    latencyMs: Date.now() - startedAt,
    rawResponse: sanitizeRawResponse(response)
  };
}

export async function closeHyperliquidPosition(supabase, userId, credential, draft, position) {
  const quantity = Number(draft.quantity || position.quantity || 0);
  const side = position.direction === "long" ? "sell" : "buy";
  return submitHyperliquidOrder(supabase, userId, credential, {
    ...draft,
    symbol: draft.symbol || position.symbol,
    side,
    orderType: draft.orderType || "market",
    type: draft.orderType || "market",
    marketKind: "perpetual",
    quantity,
    quantityMode: "quantity",
    reduceOnly: true,
    timeInForce: draft.timeInForce || "ioc",
    referencePrice: draft.referencePrice || position.currentPrice || position.averagePrice
  });
}

export async function syncHyperliquidAccount(supabase, account, credential) {
  const network = normalizeHyperliquidNetwork(credential.network);
  const transport = getHyperliquidTransport(network);
  const master = normalizeAddress(credential.master_wallet_address, "master wallet address");
  const [state, orders, fills] = await Promise.all([
    clearinghouseState({ transport }, { user: master }),
    openOrders({ transport }, { user: master }),
    userFills({ transport }, { user: master, aggregateByTime: true })
  ]);

  await upsertHyperliquidBalances(supabase, account.id, state);
  await upsertHyperliquidPositions(supabase, account.id, state);
  await supabase.from("hyperliquid_account_snapshots").insert({
    user_id: account.user_id,
    account_id: account.id,
    credential_id: credential.id,
    network,
    master_wallet_address: master,
    margin_summary: state.marginSummary,
    cross_margin_summary: state.crossMarginSummary,
    positions: state.assetPositions,
    open_orders: orders,
    fills,
    raw_payload: { state, orders, fills }
  });
  await markCredentialUsed(supabase, credential.id);

  return {
    state,
    orders,
    fills,
    balances: [{
      asset: "USDC",
      total: num(state.marginSummary.accountValue),
      free: num(state.withdrawable),
      locked: Math.max(0, num(state.marginSummary.accountValue) - num(state.withdrawable)),
      usdValue: num(state.marginSummary.accountValue)
    }],
    positions: state.assetPositions.map(mapHyperliquidPosition)
  };
}

export async function getNextHyperliquidNonce(supabase, userId, credential, signerAddress) {
  const { data, error } = await supabase.rpc("next_hyperliquid_nonce", {
    p_user_id: userId,
    p_credential_id: credential.id,
    p_agent_wallet_address: signerAddress.toLowerCase(),
    p_network: normalizeHyperliquidNetwork(credential.network)
  });

  if (error || data === null || data === undefined) {
    const nonceError = new Error("Hyperliquid nonce manager is unavailable. Apply the Phase III Chapter V nonce migration.");
    nonceError.statusCode = 503;
    throw nonceError;
  }

  await writeHyperliquidRelayEvent(supabase, {
    userId,
    credentialId: credential.id,
    eventType: "nonce_generated",
    severity: "info",
    message: "Generated monotonic Hyperliquid agent nonce.",
    metadata: {
      agentWalletAddress: signerAddress.toLowerCase(),
      network: normalizeHyperliquidNetwork(credential.network)
    }
  });

  return Number(data);
}

export async function writeHyperliquidRelayEvent(supabase, payload) {
  const { error } = await supabase.from("hyperliquid_order_relay_events").insert({
    user_id: payload.userId,
    account_id: payload.accountId ?? null,
    connection_id: payload.connectionId ?? null,
    credential_id: payload.credentialId ?? null,
    event_type: payload.eventType,
    severity: payload.severity || "info",
    symbol: payload.symbol ?? null,
    order_id: payload.orderId ?? null,
    client_order_id: payload.clientOrderId ?? null,
    exchange_order_id: payload.exchangeOrderId ?? null,
    latency_ms: payload.latencyMs ?? null,
    message: payload.message,
    metadata: payload.metadata || {}
  });

  if (error) console.error("Hyperliquid relay audit write failed", error);
}

export function buildRejectedHyperliquidUpdate(draft, reason) {
  return {
    accountId: draft.accountId,
    exchange: "hyperliquid",
    orderId: draft.internalOrderId || draft.clientOrderId || draft.orderId || `hl-rejected-${Date.now()}`,
    clientOrderId: draft.clientOrderId || draft.internalOrderId,
    symbol: draft.symbol,
    status: "rejected",
    filledQuantity: 0,
    reason,
    time: Date.now(),
    latencyMs: 0
  };
}

export function toHyperliquidExecutionReport(update, draft = {}) {
  return {
    internalOrderId: draft.internalOrderId || update.clientOrderId || update.orderId,
    accountId: update.accountId || draft.accountId,
    exchange: "hyperliquid",
    orderId: update.orderId,
    clientOrderId: update.clientOrderId,
    symbol: update.symbol || draft.symbol,
    status: update.status,
    filledQuantity: update.filledQuantity || 0,
    averageFillPrice: update.averageFillPrice,
    reason: update.reason,
    time: update.time || Date.now(),
    lifecycleState: lifecycleFromRelayStatus(update.status),
    latencyMs: update.latencyMs,
    destination: draft.destinations?.[0] || "personal-portfolio",
    diagnosticContext: {
      protocol: "hyperliquid",
      source: draft.source || "order-ticket",
      destinations: draft.destinations || ["personal-portfolio"]
    }
  };
}

export function mapHyperliquidOrderToDb(userId, account, draft, update, risk) {
  return {
    user_id: userId,
    account_id: account.id,
    exchange: "hyperliquid",
    symbol: String(draft.symbol).toUpperCase(),
    side: draft.side,
    order_type: draft.orderType || draft.type,
    quantity: Number(draft.quantity),
    quantity_mode: draft.quantityMode || draft.sizingMethod || "quantity",
    limit_price: draft.limitPrice ?? null,
    stop_price: draft.stopPrice ?? null,
    take_profit: draft.takeProfit ?? null,
    stop_loss: draft.stopLoss ?? null,
    post_only: Boolean(draft.postOnly),
    reduce_only: Boolean(draft.reduceOnly),
    time_in_force: draft.timeInForce || "gtc",
    status: update.status,
    exchange_order_id: update.exchangeOrderId || update.orderId || null,
    client_order_id: update.clientOrderId || null,
    filled_quantity: update.filledQuantity || 0,
    average_fill_price: update.averageFillPrice ?? null,
    rejection_reason: update.reason || null,
    estimated_fees: (risk?.notional || 0) * 0.0004,
    estimated_margin: (risk?.notional || 0) / Math.max(1, Number(draft.leverage || 1)),
    estimated_slippage: (risk?.notional || 0) * 0.0003,
    risk_check_status: risk?.status || "approved",
    risk_check_reasons: risk?.reasons || []
  };
}

export function unsupportedHyperliquidOrderReason(draft) {
  const type = draft.orderType || draft.type;
  if (["twap", "iceberg", "trailing-stop", "bracket"].includes(type)) {
    return `${type} is not enabled for Hyperliquid live relay yet. This order type requires a managed execution worker or explicit native support.`;
  }
  if (draft.marketKind && !["perpetual", "futures"].includes(draft.marketKind)) {
    return "Hyperliquid relay currently supports perpetual futures only.";
  }
  return "";
}

async function prepareHyperliquidOrder(network, draft) {
  const unsupportedReason = unsupportedHyperliquidOrderReason(draft);
  if (unsupportedReason) {
    const error = new Error(unsupportedReason);
    error.statusCode = 400;
    throw error;
  }

  const asset = await resolveHyperliquidAsset(network, draft.symbol);
  const quantity = Number(draft.quantity);
  const type = draft.orderType || draft.type || "market";
  const side = draft.side === "buy";
  const reduceOnly = Boolean(draft.reduceOnly);
  const referencePrice = Number(draft.referencePrice || draft.limitPrice || draft.stopPrice || 0);
  let price = Number(draft.limitPrice || draft.referencePrice || 0);
  let orderType;
  let grouping = "na";

  if (!quantity || quantity <= 0) throw validationError("Order quantity must be greater than zero.");
  validateSize(asset, quantity);
  if (draft.leverage && Number(draft.leverage) > Number(asset.maxLeverage)) {
    throw validationError(`${asset.name} max leverage is ${asset.maxLeverage}x on Hyperliquid.`);
  }

  if (type === "market") {
    price = await getAggressiveMarketPrice(network, asset.name, side);
    orderType = { limit: { tif: "FrontendMarket" } };
  } else if (type === "limit" || type === "post-only") {
    if (!price || price <= 0) throw validationError("Limit price is required.");
    orderType = { limit: { tif: draft.postOnly || type === "post-only" ? "Alo" : tif(draft.timeInForce) } };
  } else if (type === "stop-market" || type === "stop-limit") {
    const triggerPx = Number(draft.stopPrice || draft.takeProfit || draft.stopLoss || draft.limitPrice || 0);
    if (!triggerPx || triggerPx <= 0) throw validationError("Trigger price is required.");
    price = type === "stop-limit" ? Number(draft.limitPrice || triggerPx) : await getAggressiveMarketPrice(network, asset.name, side);
    orderType = {
      trigger: {
        isMarket: type === "stop-market",
        triggerPx: formatDecimal(triggerPx, asset.priceMaxDecimals),
        tpsl: inferTpSl(draft, side, referencePrice || triggerPx)
      }
    };
    grouping = "normalTpsl";
    if (!reduceOnly) throw validationError("Hyperliquid TP/SL trigger orders must be reduce-only.");
  } else {
    throw validationError(`${type} is not supported by the Hyperliquid relay.`);
  }

  validatePrice(asset, price);
  if (quantity * price < asset.minNotional) {
    throw validationError(`Order notional must be at least $${asset.minNotional}.`);
  }

  return {
    asset,
    grouping,
    order: {
      a: asset.assetId,
      b: side,
      p: formatDecimal(price, asset.priceMaxDecimals),
      s: formatDecimal(quantity, asset.szDecimals),
      r: reduceOnly,
      t: orderType,
      c: normalizeClientOrderId(draft.clientOrderId || draft.internalOrderId || crypto.randomUUID())
    }
  };
}

async function resolveHyperliquidAsset(network, symbol) {
  const metadata = await getHyperliquidMetadata(network);
  const clean = String(symbol || "").toUpperCase().replace(/[-_/]/g, "");
  const coin = clean.replace(/PERP$/, "").replace(/USDT$/, "").replace(/USD$/, "");
  const asset = metadata.byCoin.get(coin) || metadata.bySymbol.get(clean);
  if (!asset || asset.isDelisted) throw validationError(`${symbol} is not a supported Hyperliquid perpetual symbol.`);
  return asset;
}

function createExchangeConfig({ supabase, userId, credential, wallet, transport }) {
  return {
    transport,
    wallet,
    defaultVaultAddress: credential.vault_address || undefined,
    nonceManager: async (address) => getNextHyperliquidNonce(supabase, userId, credential, address)
  };
}

function getHyperliquidEncryptionKey() {
  const rawKey = process.env.HYPERLIQUID_CREDENTIAL_ENCRYPTION_KEY;
  if (!rawKey) throw new Error("Missing HYPERLIQUID_CREDENTIAL_ENCRYPTION_KEY.");

  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    throw new Error("HYPERLIQUID_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

async function getAggressiveMarketPrice(network, coin, isBuy) {
  const transport = getHyperliquidTransport(network);
  const mids = await allMids({ transport });
  const mid = Number(mids[coin]);
  if (!mid || !Number.isFinite(mid)) throw validationError(`No Hyperliquid mid price available for ${coin}.`);
  return isBuy ? mid * 1.01 : mid * 0.99;
}

function normalizeOrderResponse(response, draft, prepared, latencyMs) {
  const status = response.response.data.statuses[0];
  const base = {
    accountId: draft.accountId,
    exchange: "hyperliquid",
    symbol: draft.symbol,
    clientOrderId: prepared.order.c,
    time: Date.now(),
    latencyMs,
    rawResponse: sanitizeRawResponse(response)
  };

  if (typeof status === "object" && status.error) {
    return {
      ...base,
      orderId: prepared.order.c,
      status: "rejected",
      filledQuantity: 0,
      reason: status.error
    };
  }
  if (typeof status === "object" && status.resting) {
    return {
      ...base,
      orderId: String(status.resting.oid),
      exchangeOrderId: String(status.resting.oid),
      status: "accepted",
      filledQuantity: 0
    };
  }
  if (typeof status === "object" && status.filled) {
    return {
      ...base,
      orderId: String(status.filled.oid),
      exchangeOrderId: String(status.filled.oid),
      status: "filled",
      filledQuantity: num(status.filled.totalSz),
      averageFillPrice: num(status.filled.avgPx)
    };
  }

  return {
    ...base,
    orderId: prepared.order.c,
    status: "accepted",
    filledQuantity: 0,
    reason: typeof status === "string" ? status : undefined
  };
}

function lifecycleFromRelayStatus(status) {
  if (status === "accepted") return "accepted";
  if (status === "filled") return "filled";
  if (status === "cancelled") return "cancelled";
  if (status === "partially-filled") return "partially-filled";
  return "rejected";
}

async function markCredentialUsed(supabase, credentialId) {
  await supabase
    .from("hyperliquid_credentials")
    .update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", credentialId);
}

async function upsertHyperliquidBalances(supabase, accountId, state) {
  await supabase.from("account_balances").upsert({
    account_id: accountId,
    asset: "USDC",
    free: num(state.withdrawable),
    locked: Math.max(0, num(state.marginSummary.accountValue) - num(state.withdrawable)),
    total: num(state.marginSummary.accountValue),
    usd_value: num(state.marginSummary.accountValue),
    updated_at: new Date().toISOString()
  }, { onConflict: "account_id,asset" });
}

async function upsertHyperliquidPositions(supabase, accountId, state) {
  const rows = state.assetPositions
    .map(mapHyperliquidPosition)
    .filter((position) => position.quantity > 0)
    .map((position) => ({
      account_id: accountId,
      exchange: "hyperliquid",
      symbol: position.symbol,
      direction: position.direction,
      quantity: position.quantity,
      average_price: position.averagePrice,
      current_price: position.currentPrice,
      unrealized_pnl: position.unrealizedPnl,
      realized_pnl: 0,
      margin: position.margin,
      leverage: position.leverage,
      liquidation_price: position.liquidationPrice,
      opened_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));

  if (rows.length) {
    await supabase
      .from("account_positions")
      .upsert(rows, { onConflict: "account_id,symbol,direction" });
  }
}

function mapHyperliquidPosition(row) {
  const position = row.position;
  const signedSize = num(position.szi);
  return {
    symbol: `${position.coin}USDT`,
    direction: signedSize < 0 ? "short" : "long",
    quantity: Math.abs(signedSize),
    averagePrice: num(position.entryPx),
    currentPrice: num(position.positionValue) / Math.max(Math.abs(signedSize), 1),
    unrealizedPnl: num(position.unrealizedPnl),
    margin: num(position.marginUsed),
    leverage: Number(position.leverage?.value || 1),
    liquidationPrice: position.liquidationPx === null ? null : num(position.liquidationPx)
  };
}

function validateSize(asset, quantity) {
  if (decimalPlaces(quantity) > Number(asset.szDecimals)) {
    throw validationError(`${asset.name} size supports up to ${asset.szDecimals} decimals.`);
  }
}

function validatePrice(asset, price) {
  if (decimalPlaces(price) > Number(asset.priceMaxDecimals)) {
    throw validationError(`${asset.name} price supports up to ${asset.priceMaxDecimals} decimals.`);
  }
  if (!Number.isInteger(price) && significantFigures(price) > 5) {
    throw validationError(`${asset.name} price supports up to 5 significant figures.`);
  }
}

function inferTpSl(draft, isBuy, referencePrice) {
  if (draft.takeProfit) return "tp";
  if (draft.stopLoss) return "sl";
  const trigger = Number(draft.stopPrice || draft.limitPrice || 0);
  if (!trigger || !referencePrice) return "sl";
  return isBuy ? (trigger < referencePrice ? "tp" : "sl") : (trigger > referencePrice ? "tp" : "sl");
}

function tif(value) {
  if (value === "ioc" || value === "fok") return "Ioc";
  return "Gtc";
}

function normalizeClientOrderId(value) {
  const clean = String(value || "").trim();
  if (/^0x[0-9a-fA-F]{32}$/.test(clean)) return clean;
  return `0x${crypto.createHash("sha256").update(clean || crypto.randomUUID()).digest("hex").slice(0, 32)}`;
}

function formatDecimal(value, maxDecimals) {
  const fixed = Number(value).toFixed(Math.max(0, Number(maxDecimals)));
  return fixed.replace(/\.?0+$/, "");
}

function decimalPlaces(value) {
  const text = String(value);
  if (!text.includes(".")) return 0;
  return text.split(".")[1].replace(/0+$/, "").length;
}

function significantFigures(value) {
  return String(Number(value).toPrecision(15))
    .replace(".", "")
    .replace(/^0+/, "")
    .replace(/0+$/, "")
    .length;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function sanitizeRawResponse(response) {
  return JSON.parse(JSON.stringify(response));
}

function num(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
