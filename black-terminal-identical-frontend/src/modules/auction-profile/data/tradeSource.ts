import type { TradeTick } from "../../../market-data/types.ts";
import type {
  CanonicalAggressorSource,
  CanonicalCVDService,
  CanonicalCvdQuery,
  CanonicalTrade
} from "../core/types.ts";
import { canonicalTradeFromTick } from "../core/types.ts";

function key(venue: string, symbol: string) {
  return venue.toLowerCase() + ":" + symbol.toUpperCase();
}

export function aggressorSourceForTick(tick: TradeTick): CanonicalAggressorSource {
  if (tick.aggressorSource) return tick.aggressorSource;
  if (tick.exchange === "bybit" || tick.exchange === "okx") return "EXCHANGE_AGGRESSOR_FLAG";
  if (tick.exchange === "binance" || tick.exchange === "binance-us") return "MAKER_SIDE_INVERSION";
  return "INFERRED";
}

export function normalizeCanonicalTrade(tick: TradeTick) {
  return canonicalTradeFromTick(tick, aggressorSourceForTick(tick));
}

export class InMemoryCanonicalCvdService implements CanonicalCVDService {
  private tradesByMarket = new Map<string, CanonicalTrade[]>();
  private idsByMarket = new Map<string, Set<string>>();
  private readonly maximumTradesPerMarket: number;

  constructor(maximumTradesPerMarket = 250_000) {
    this.maximumTradesPerMarket = maximumTradesPerMarket;
  }

  ingest(trades: readonly CanonicalTrade[]) {
    let accepted = 0;
    for (const trade of trades) {
      if (!(trade.timestamp > 0 && trade.price > 0 && trade.quantity >= 0)) continue;
      const market = key(trade.venue, trade.symbol);
      const rows = this.tradesByMarket.get(market) ?? [];
      const ids = this.idsByMarket.get(market) ?? new Set<string>();
      const identity = trade.tradeId || String(trade.timestamp) + ":" + trade.price + ":" + trade.quantity;
      if (ids.has(identity)) continue;
      rows.push({ ...trade, tradeId: identity });
      ids.add(identity);
      accepted += 1;
      if (rows.length > this.maximumTradesPerMarket) {
        const removed = rows.splice(0, rows.length - this.maximumTradesPerMarket);
        removed.forEach(item => ids.delete(item.tradeId));
      }
      this.tradesByMarket.set(market, rows);
      this.idsByMarket.set(market, ids);
    }
    return accepted;
  }

  getTrades(query: CanonicalCvdQuery) {
    return (this.tradesByMarket.get(key(query.venue, query.symbol)) ?? [])
      .filter(trade => trade.timestamp >= query.start && trade.timestamp <= query.end)
      .sort((left, right) => left.timestamp - right.timestamp || left.tradeId.localeCompare(right.tradeId));
  }

  getDeltaSeries(query: CanonicalCvdQuery) {
    let cumulativeDelta = 0;
    return this.getTrades(query).map(trade => {
      const buyQuantity = trade.aggressorSide === "BUY" ? trade.quantity : 0;
      const sellQuantity = trade.aggressorSide === "SELL" ? trade.quantity : 0;
      const unknownQuantity = trade.aggressorSide === "UNKNOWN" ? trade.quantity : 0;
      const delta = buyQuantity - sellQuantity;
      cumulativeDelta += delta;
      return { time: trade.timestamp, buyQuantity, sellQuantity, unknownQuantity, delta, cumulativeDelta };
    });
  }

  coverage(query: CanonicalCvdQuery) {
    const trades = this.getTrades(query);
    const quantity = trades.reduce((sum, trade) => sum + trade.quantity, 0);
    const unknown = trades.reduce((sum, trade) => sum + (trade.aggressorSide === "UNKNOWN" ? trade.quantity : 0), 0);
    const exact = trades.reduce((sum, trade) => sum + (trade.source === "EXCHANGE_AGGRESSOR_FLAG" || trade.source === "MAKER_SIDE_INVERSION" ? trade.quantity : 0), 0);
    return {
      exactTradeCoveragePercent: quantity > 0 ? exact / quantity * 100 : 0,
      unknownAggressorPercent: quantity > 0 ? unknown / quantity * 100 : 0
    };
  }

  clear(venue?: string, symbol?: string) {
    if (!venue) {
      this.tradesByMarket.clear();
      this.idsByMarket.clear();
      return;
    }
    if (symbol) {
      const market = key(venue, symbol);
      this.tradesByMarket.delete(market);
      this.idsByMarket.delete(market);
      return;
    }
    const prefix = venue.toLowerCase() + ":";
    for (const market of this.tradesByMarket.keys()) {
      if (market.startsWith(prefix)) {
        this.tradesByMarket.delete(market);
        this.idsByMarket.delete(market);
      }
    }
  }
}

export const canonicalCvdService = new InMemoryCanonicalCvdService();
