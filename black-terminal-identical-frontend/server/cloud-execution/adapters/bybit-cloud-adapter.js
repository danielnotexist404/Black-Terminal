import {
  cancelBybitOrder,
  getBybitAccountInfo,
  getBybitOpenOrders,
  getBybitPositions,
  getBybitTicker,
  getBybitWalletSnapshot,
  modifyBybitOrder,
  placeBybitOrder,
  validateBybitCredentials
} from "../../exchanges/bybit.js";
import { BybitPrivateStreamClient } from "../../exchanges/bybit-private-stream.js";
import { syncBybitSnapshotAndReconcile } from "../../exchanges/bybit-reconciliation.js";
import { ExchangeAdapter } from "./exchange-adapter.js";

export class BybitCloudAdapter extends ExchangeAdapter {
  constructor(options = {}) {
    super({ ...options, credentials: { ...options.credentials, network: options.network } });
  }
  async connect() { return this.authenticate(); }
  async authenticate() { return validateBybitCredentials(this.credentials); }
  async getAccount() {
    const [account, wallet] = await Promise.all([getBybitAccountInfo(this.credentials), getBybitWalletSnapshot(this.credentials)]);
    return { account, wallet };
  }
  async getPositions(options = {}) { return getBybitPositions(this.credentials, options); }
  async getOrders(options = {}) { return getBybitOpenOrders(this.credentials, options); }
  async placeOrder(order, validation) { return placeBybitOrder(this.credentials, order, validation); }
  async cancelOrder(order) { return cancelBybitOrder(this.credentials, order); }
  async modifyOrder(order) { return modifyBybitOrder(this.credentials, order); }
  async subscribeMarketData({ symbol = "BTCUSDT", category = "linear", onSnapshot } = {}) {
    const snapshot = await getBybitTicker({ symbol, category, network: this.network });
    onSnapshot?.(snapshot);
    return { mode: "REST_SNAPSHOT", snapshot };
  }
  async subscribePrivateEvents({ onMessage, onError } = {}) {
    const client = new BybitPrivateStreamClient(this.credentials, { network: this.network, connectionId: this.connectionId });
    if (onMessage) client.onMessage(onMessage);
    if (onError) client.onError(onError);
    await client.connect();
    return client;
  }
  async reconcile({ supabase, userId, account, symbol = "BTCUSDT", marketKind = "perpetual" }) {
    return syncBybitSnapshotAndReconcile(supabase, userId, account, this.credentials, { symbol, marketKind, network: this.network });
  }
}
