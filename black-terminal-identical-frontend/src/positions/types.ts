import type { ExchangeId } from "../market-data/types";

export type PortfolioPosition = {
  id: string;
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  margin: number;
  leverage: number;
  liquidationPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
};
