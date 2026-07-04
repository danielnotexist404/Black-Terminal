import type { AccountConnection, Balance, OrderRequest, OrderUpdate } from "../execution/types";
import type { ExchangeId } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";
import type { AccountHealth, BrokerCapabilities, ExchangeBrokerAdapter } from "./types";

const defaultCapabilities: BrokerCapabilities = {
  liveMarketData: true,
  orderPlacement: false,
  positionSync: true,
  orderSync: true,
  balanceSync: true,
  tradeHistory: true,
  twap: false,
  iceberg: false
};

export class MockExchangeBrokerAdapter implements ExchangeBrokerAdapter {
  capabilities = defaultCapabilities;

  constructor(
    public exchange: ExchangeId,
    public label: string
  ) {}

  async validateConnection(): Promise<AccountHealth> {
    return {
      status: "read-only",
      apiHealth: "healthy",
      latencyMs: 24 + Math.round(Math.random() * 38),
      checkedAt: Date.now()
    };
  }

  async getBalances(accountId: string): Promise<Balance[]> {
    void accountId;
    return [];
  }

  async getPositions(accountId: string): Promise<PortfolioPosition[]> {
    void accountId;
    return [];
  }

  async placeOrder(order: OrderRequest): Promise<OrderUpdate> {
    return {
      accountId: order.accountId,
      exchange: this.exchange,
      orderId: `paper-${Date.now()}`,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      status: "rejected",
      filledQuantity: 0,
      reason: "Phase 1 adapter is read-only until secure exchange execution is configured.",
      time: Date.now()
    };
  }

  async cancelOrder(accountId: string, orderId: string): Promise<OrderUpdate> {
    return {
      accountId,
      exchange: this.exchange,
      orderId,
      symbol: "UNKNOWN",
      status: "cancelled",
      filledQuantity: 0,
      time: Date.now()
    };
  }
}
