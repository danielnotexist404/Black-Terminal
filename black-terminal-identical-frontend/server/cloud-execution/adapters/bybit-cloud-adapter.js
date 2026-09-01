import {
  cancelAllBybitOrders,
  cancelBybitOrder,
  getBybitAccountInfo,
  getBybitBalances,
  getBybitExecutions,
  getBybitOpenOrders,
  getBybitPositions,
  getBybitTicker,
  getBybitInstrumentMetadata,
  getBybitApiKeyInformation,
  getBybitServerTime,
  getBybitWalletSnapshot,
  findBybitOrderByClientOrderId,
  modifyBybitOrder,
  placeBybitOrder,
  placeBybitStrategyOrder,
  setBybitLeverage,
  setBybitPositionProtection,
  validateBybitMainnetValidationRequest,
  validateBybitManagementGate,
  validateBybitOrderDraft,
  validateBybitCredentials,
  normalizeBybitPermissionReport,
  resolveBybitExecutionPolicy
} from "../../exchanges/bybit.js";
import { BybitPrivateStreamClient } from "../../exchanges/bybit-private-stream.js";
import { syncBybitSnapshotAndReconcile } from "../../exchanges/bybit-reconciliation.js";
import { ExchangeAdapter } from "./exchange-adapter.js";
import { getBrokerAdapterDefinition } from "../../exchanges/broker-adapter-registry.js";

export class BybitCloudAdapter extends ExchangeAdapter {
  constructor(options = {}) {
    const executionEnvironment = options.executionEnvironment || options.network || options.credentials?.executionEnvironment || options.credentials?.network;
    const endpointProfile = options.endpointProfile || options.credentials?.endpointProfile || "GLOBAL";
    super({
      ...options,
      executionEnvironment,
      endpointProfile,
      credentials: { ...options.credentials, executionEnvironment, endpointProfile }
    });
    this.provider = "bybit";
    this.client = null;
    this.health = { provider: "bybit", state: "DISCONNECTED", connected: false, reconnectAttempts: 0, degradationReasons: [] };
  }

  async verifyCredentials() {
    this.health.state = "VERIFYING";
    const result = await validateBybitCredentials(this.credentials);
    this.health.state = "AUTHENTICATED";
    this.health.lastAuthenticatedAt = Date.now();
    return result;
  }

  async connect(context = {}) {
    await this.verifyCredentials();
    if (context.onAccountEvent) await this.subscribeAccountEvents(context.onAccountEvent, context);
    return this.getHealth();
  }

  async disconnect(reason = "requested") {
    this.client?.disconnect?.();
    this.client = null;
    this.health = { ...this.health, state: "DISCONNECTED", connected: false, disconnectedReason: String(reason) };
  }

  async synchronizeAccount(context = {}) {
    this.health.state = "SYNCHRONIZING";
    if (context.supabase && context.userId && context.account) {
      const result = await syncBybitSnapshotAndReconcile(context.supabase, context.userId, context.account, this.credentials, {
        symbol: context.symbol || "BTCUSDT",
        marketKind: context.marketKind || "perpetual",
        network: this.network
      });
      this.health = { ...this.health, state: "READY", connected: true, lastSynchronizedAt: Date.now(), degradationReasons: [] };
      return result;
    }
    const [account, balances, positions, orders] = await Promise.all([
      getBybitAccountInfo(this.credentials), getBybitBalances(this.credentials),
      getBybitPositions(this.credentials), getBybitOpenOrders(this.credentials)
    ]);
    this.health = { ...this.health, state: "READY", connected: true, lastSynchronizedAt: Date.now(), degradationReasons: [] };
    return { account, balances, positions, openOrders: orders.orders || [] };
  }

  async placeOrder(order, validation) { return placeBybitOrder(this.credentials, order, validation); }
  async configureLeverage(request) { return setBybitLeverage(this.credentials, request); }
  async setPositionProtection(request) { return setBybitPositionProtection(this.credentials, request); }
  async placeStrategyOrder(order, validation) { return placeBybitStrategyOrder(this.credentials, order, validation); }
  async cancelOrder(request) { return cancelBybitOrder(this.credentials, request); }
  async modifyOrder(request) { return modifyBybitOrder(this.credentials, request); }
  async cancelAll(request = {}) { return cancelAllBybitOrders(this.credentials, request); }
  async validateOrderDraft(order) { return validateBybitOrderDraft(this.credentials, order); }
  async getWalletSnapshot() { return getBybitWalletSnapshot(this.credentials); }
  validateProductionGate(context) { return validateBybitMainnetValidationRequest(context); }
  validateManagementGate(context) { return validateBybitManagementGate(context); }
  async findOrderByClientOrderId(request) { return findBybitOrderByClientOrderId(this.credentials, request); }
  async fetchPositions(options = {}) { return getBybitPositions(this.credentials, options); }
  async fetchOpenOrders(options = {}) { return (await getBybitOpenOrders(this.credentials, options)).orders || []; }
  async fetchBalances() { return getBybitBalances(this.credentials); }
  async fetchExecutions(since) { return getBybitExecutions(this.credentials, { startTime: since }); }
  async getInstruments({ category = "linear", symbol = "BTCUSDT" } = {}) { return [await getBybitInstrumentMetadata({ category, symbol, executionEnvironment: this.executionEnvironment, endpointProfile: this.endpointProfile })]; }
  getCapabilities() { return getBrokerAdapterDefinition("bybit"); }
  async healthCheck() {
    const startedAt = Date.now();
    const [time, apiKeyInfo] = await Promise.all([
      getBybitServerTime(this.credentials),
      getBybitApiKeyInformation(this.credentials)
    ]);
    const permissions = normalizeBybitPermissionReport(apiKeyInfo);
    const executionPolicy = resolveBybitExecutionPolicy(permissions, {
      executionEnvironment: this.executionEnvironment,
      network: this.network
    });
    this.health = { ...this.health, state: "AUTHENTICATED", connected: true, lastAuthenticatedAt: Date.now(), degradationReasons: [] };
    return {
      ...this.getHealth(),
      latencyMs: Date.now() - startedAt,
      authentication: "authenticated",
      permissions,
      executionPolicy,
      clockSkewMs: time.clockSkewMs
    };
  }
  async reconnect(context = {}) {
    await this.disconnect("reconnect");
    return this.connect(context);
  }

  async subscribeMarketData({ symbol = "BTCUSDT", category = "linear", onSnapshot } = {}) {
    const snapshot = await getBybitTicker({ symbol, category, executionEnvironment: this.executionEnvironment, endpointProfile: this.endpointProfile });
    onSnapshot?.(snapshot);
    return { mode: "REST_SNAPSHOT", snapshot };
  }

  async subscribeAccountEvents(handler, { onError } = {}) {
    if (this.client) return subscription(this.client);
    const client = new BybitPrivateStreamClient(this.credentials, {
      executionEnvironment: this.executionEnvironment,
      endpointProfile: this.endpointProfile,
      connectionId: this.connectionId
    });
    this.client = client;
    client.onMessage((event) => {
      this.health = { ...this.health, state: "READY", connected: true, lastAccountEventAt: Number(event.time || Date.now()), degradationReasons: [] };
      handler?.(event);
    });
    client.onError((error) => {
      this.health = { ...this.health, state: "DEGRADED", connected: false, degradationReasons: ["PRIVATE_STREAM_ERROR"] };
      onError?.(error);
    });
    try {
      await client.connect();
    } catch (error) {
      client.disconnect();
      this.client = null;
      this.health = { ...this.health, state: "DEGRADED", connected: false, degradationReasons: [error?.code || "PRIVATE_STREAM_START_FAILED"] };
      throw error;
    }
    const diagnostics = client.diagnostics();
    this.health = {
      ...this.health,
      state: diagnostics.status === "connected" ? "READY" : "AUTHENTICATING",
      connected: diagnostics.status === "connected",
      lastAuthenticatedAt: diagnostics.authenticated ? Date.now() : this.health.lastAuthenticatedAt
    };
    return subscription(client);
  }

  getHealth() {
    const diagnostics = this.client?.diagnostics?.();
    return {
      ...this.health,
      connected: diagnostics ? diagnostics.status === "connected" : this.health.connected,
      state: diagnostics ? diagnostics.status === "connected" ? "READY" : "DEGRADED" : this.health.state,
      privateStreamState: diagnostics?.status || "disconnected",
      reconnectAttempts: Number(diagnostics?.reconnectCount || this.health.reconnectAttempts || 0),
      lastAccountEventAt: diagnostics?.lastMessageAt || this.health.lastAccountEventAt || null
    };
  }

  async reconcile(context) { return this.synchronizeAccount(context); }
}

function subscription(client) {
  return { close: () => client.disconnect(), diagnostics: () => client.diagnostics() };
}
