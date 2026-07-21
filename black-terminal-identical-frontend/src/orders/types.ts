export type AdvancedOrderType =
  | "market"
  | "limit"
  | "stop-market"
  | "stop-limit"
  | "bracket"
  | "twap"
  | "iceberg";

export type OrderTicketDraft = {
  orderType: AdvancedOrderType;
  side: "buy" | "sell";
  symbol: string;
  quantityMode: "quantity" | "usd" | "contracts" | "riskPct" | "equityPct";
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  postOnly: boolean;
  reduceOnly: boolean;
  timeInForce: "gtc" | "ioc" | "fok";
};

export type OrderEstimate = {
  fees: number;
  margin: number;
  liquidationPrice?: number;
  slippage: number;
  riskReward?: number;
};
