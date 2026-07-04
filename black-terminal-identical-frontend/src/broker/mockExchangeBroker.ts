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
    return [
      { accountId, exchange: this.exchange, asset: "USDT", free: 62_400, locked: 8_100, total: 70_500, usdValue: 70_500 },
      { accountId, exchange: this.exchange, asset: "BTC", free: 0.62, locked: 0.18, total: 0.8, usdValue: 53_280 }
    ];
  }

  async getPositions(accountId: string): Promise<PortfolioPosition[]> {
    return [
      {
        id: `${accountId}-BTCUSDT`,
        accountId,
        exchange: this.exchange,
        symbol: "BTCUSDT",
        direction: "long",
        quantity: 0.82,
        averagePrice: 64_280,
        currentPrice: 66_610,
        unrealizedPnl: 1_910.6,
        realizedPnl: 420,
        margin: 10_548,
        leverage: 5,
        liquidationPrice: 54_920,
        stopLoss: 63_400,
        takeProfit: 69_800,
        openedAt: Date.now() - 1000 * 60 * 60 * 9
      },
      {
        id: `${accountId}-ETHUSDT`,
        accountId,
        exchange: this.exchange,
        symbol: "ETHUSDT",
        direction: "short",
        quantity: 7.4,
        averagePrice: 3_520,
        currentPrice: 3_482,
        unrealizedPnl: 281.2,
        realizedPnl: -84,
        margin: 5_153,
        leverage: 4,
        liquidationPrice: 3_880,
        openedAt: Date.now() - 1000 * 60 * 38
      }
    ];
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
