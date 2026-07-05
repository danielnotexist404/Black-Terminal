import type { Candle } from "../../chart-engine/types";
import type {
  ExchangeId,
  FundingRate,
  MarketSymbol,
  OpenInterest,
  OrderBookSnapshot,
  TickerSnapshot,
  TradeTick
} from "../../market-data/types";
import type { ExecutionEvent } from "../../execution/executionEvents";
import type { ConnectivityEvent } from "../../connectivity/connectionEvents";
import type { PositionLifecycleEvent } from "../../positions/types";

export type MarketConnectionEvent = {
  exchange: ExchangeId;
  connectedAt?: number;
  disconnectedAt?: number;
  latencyMs?: number;
  reason?: string;
};

export type MarketEventMap = {
  "market.connected": MarketConnectionEvent;
  "market.disconnected": MarketConnectionEvent;
  "market.error": MarketConnectionEvent & { message: string };
  "trade.received": TradeTick;
  "ticker.updated": TickerSnapshot;
  "candle.updated": Candle & { symbol: MarketSymbol };
  "candle.closed": Candle & { symbol: MarketSymbol };
  "orderbook.updated": OrderBookSnapshot;
  "funding.updated": FundingRate;
  "openInterest.updated": OpenInterest;
  "liquidation.received": { exchange: ExchangeId; symbol: string; price: number; quantity: number; side: "buy" | "sell"; time: number };
  "position.updated": { accountId: string; symbol: string; time: number };
  "position.lifecycle": PositionLifecycleEvent;
  "portfolio.updated": { accountId?: string; time: number };
  "execution.event": ExecutionEvent;
  "connectivity.event": ConnectivityEvent;
  "performance.metric": { name: string; value: number; unit: string; time: number; tags?: Record<string, string> };
};
