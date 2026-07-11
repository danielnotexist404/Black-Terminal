import type { ConnectionRecord } from "../connectivity/types";
import { MAINNET_ORDER_CONFIRMATION, validateMainnetOrderReadiness } from "../execution/mainnetValidationMode";
import type { AccountConnection, Balance, OrderRequest, OrderUpdate } from "../execution/types";
import { submitPortfolioOrderViaApi, syncExchangeAccountViaApi } from "../portfolio/portfolioApiClient";
import type { PortfolioPosition } from "../positions/types";
import type { AccountHealth, BrokerCapabilities, ExchangeBrokerAdapter } from "./types";

export class ServerExchangeBrokerAdapter implements ExchangeBrokerAdapter {
  capabilities: BrokerCapabilities;

  constructor(
    public connection: ConnectionRecord
  ) {
    this.capabilities = {
      liveMarketData: true,
      orderPlacement: connection.health.permissions.trading === true,
      positionSync: true,
      orderSync: true,
      balanceSync: true,
      tradeHistory: true,
      twap: false,
      iceberg: false
    };
  }

  get exchange() {
    return this.connection.provider as ExchangeBrokerAdapter["exchange"];
  }

  get label() {
    return this.connection.label;
  }

  async validateConnection(_connection: AccountConnection): Promise<AccountHealth> {
    return {
      status: this.connection.health.permissions.trading ? "connected" : "read-only",
      apiHealth: this.connection.health.authentication === "authenticated" ? "healthy" : "warning",
      latencyMs: this.connection.health.latencyMs,
      checkedAt: Date.now()
    };
  }

  async getBalances(accountId: string): Promise<Balance[]> {
    await syncExchangeAccountViaApi(accountId).catch(() => null);
    return [];
  }

  async getPositions(accountId: string): Promise<PortfolioPosition[]> {
    await syncExchangeAccountViaApi(accountId).catch(() => null);
    return [];
  }

  async placeOrder(order: OrderRequest): Promise<OrderUpdate> {
    const readiness = validateMainnetOrderReadiness(this.connection);
    if (!readiness.allowed) {
      return {
        accountId: order.accountId,
        exchange: this.exchange,
        orderId: order.internalOrderId || order.clientOrderId || `blocked-${Date.now()}`,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        status: "rejected",
        filledQuantity: 0,
        reason: readiness.reason || "Mainnet validation is blocked.",
        time: Date.now()
      };
    }

    const update = await submitPortfolioOrderViaApi({
      accountId: order.accountId,
      exchange: this.exchange,
      symbol: order.symbol,
      marketKind: order.marketKind,
      side: order.side,
      orderType: order.type,
      quantity: order.quantity,
      sizingMethod: order.sizingMethod,
      quantityMode: order.sizingMethod,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      referencePrice: order.referencePrice,
      leverage: order.leverage,
      marginMode: order.marginMode,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss,
      reduceOnly: order.reduceOnly,
      postOnly: order.postOnly,
      timeInForce: order.timeInForce,
      source: order.source,
      destinations: order.destinations,
      internalOrderId: order.internalOrderId,
      clientOrderId: order.clientOrderId,
      mainnetConfirmed: readiness.mainnet && readiness.allowed,
      liveConfirmation: readiness.mainnet && readiness.allowed ? MAINNET_ORDER_CONFIRMATION : undefined
    });

    if (!update) {
      throw new Error("Supabase session is required for server exchange execution.");
    }

    return update;
  }

  async cancelOrder(accountId: string, orderId: string): Promise<OrderUpdate> {
    return {
      accountId,
      exchange: this.exchange,
      orderId,
      symbol: "UNKNOWN",
      status: "rejected",
      filledQuantity: 0,
      reason: "Server-backed CEX cancel is exposed through the execution cancel API.",
      time: Date.now()
    };
  }
}
