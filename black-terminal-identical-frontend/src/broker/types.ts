import type { AccountConnection, Balance, OrderRequest, OrderUpdate } from "../execution/types";
import type { ExchangeId } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";

export type BrokerHealth = "connected" | "degraded" | "offline" | "read-only";

export type BrokerCapabilities = {
  liveMarketData: boolean;
  orderPlacement: boolean;
  positionSync: boolean;
  orderSync: boolean;
  balanceSync: boolean;
  tradeHistory: boolean;
  twap: boolean;
  iceberg: boolean;
};

export type AccountHealth = {
  status: BrokerHealth;
  apiHealth: "healthy" | "warning" | "failed";
  latencyMs: number;
  checkedAt: number;
};

export interface ExchangeBrokerAdapter {
  exchange: ExchangeId;
  label: string;
  capabilities: BrokerCapabilities;
  validateConnection(connection: AccountConnection): Promise<AccountHealth>;
  getBalances(accountId: string): Promise<Balance[]>;
  getPositions(accountId: string): Promise<PortfolioPosition[]>;
  placeOrder(order: OrderRequest): Promise<OrderUpdate>;
  cancelOrder(accountId: string, orderId: string): Promise<OrderUpdate>;
}
