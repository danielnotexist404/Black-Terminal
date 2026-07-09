import { useEffect, useState } from "react";
import { getMarketDataEngineAdapter } from "../market-data/engine/marketDataEngine";
import { MarketDataSubscription, MarketSymbol, TradeTick } from "../market-data/types";

type TradesTapeProps = {
  marketSymbol: MarketSymbol;
  exchangeLabel: string;
};

function formatPrice(price: number) {
  return price.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function formatTime(time: number) {
  return new Date(time * 1000).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function TradesTape({ marketSymbol, exchangeLabel }: TradesTapeProps) {
  const [trades, setTrades] = useState<TradeTick[]>([]);
  const [status, setStatus] = useState("CONNECTING");

  useEffect(() => {
    let subscription: MarketDataSubscription<TradeTick> | undefined;
    let pollTimer: number | undefined;
    let disposed = false;
    const seenTrades = new Set<string>();
    const seenTradeOrder: string[] = [];
    const adapter = getMarketDataEngineAdapter(marketSymbol.exchange);

    const pushTrades = (nextTrades: TradeTick[], status: string) => {
      const unseen = nextTrades.filter((trade) => {
        if (seenTrades.has(trade.tradeId)) return false;
        seenTrades.add(trade.tradeId);
        seenTradeOrder.push(trade.tradeId);
        if (seenTradeOrder.length > 2500) {
          const expiredTradeId = seenTradeOrder.shift();
          if (expiredTradeId) seenTrades.delete(expiredTradeId);
        }
        return true;
      });
      if (unseen.length === 0) return;

      setStatus(status);
      setTrades((current) => [...unseen.reverse(), ...current].slice(0, 12));
    };

    const pollTrades = () => {
      if (!adapter?.getRecentTrades) {
        if (!disposed) setStatus("TAPE FALLBACK");
        return;
      }

      adapter
        .getRecentTrades(marketSymbol, 25)
        .then((nextTrades) => {
          if (!disposed) pushTrades(nextTrades, "REST TAPE");
        })
        .catch((err: unknown) => {
          console.error(`${adapter.label} trades REST heartbeat failed`, err);
          if (!disposed) setStatus("TAPE FALLBACK");
        });
    };

    setTrades([]);
    setStatus("CONNECTING");
    subscription = adapter?.subscribeTrades?.(marketSymbol, (trade) => {
      pushTrades([trade], "LIVE TAPE");
    });

    subscription?.onError((err) => {
      console.error(`${adapter?.label ?? exchangeLabel} trades stream failed`, err);
      if (disposed) return;
      if (!disposed) setStatus("REST TAPE");
      if (!pollTimer) {
        pollTrades();
        pollTimer = window.setInterval(pollTrades, 1000);
      }
    });

    pollTrades();
    if (!subscription) pollTimer = window.setInterval(pollTrades, 1000);

    return () => {
      disposed = true;
      subscription?.unsubscribe();
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }, [
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    marketSymbol.marketKind,
    marketSymbol.baseAsset,
    marketSymbol.quoteAsset,
    exchangeLabel
  ]);

  return (
    <div className="tape panel-block">
      <div className="panel-title underlined">
        TRADES TAPE <span>{status}</span>
      </div>
      {trades.length === 0
        ? <div className="tape-empty">Trade stream unavailable for this venue.</div>
        : trades.map((trade) => (
            <div className="tape-row" key={trade.tradeId}>
              <span className={trade.side === "sell" ? "red" : "green"}>{formatPrice(trade.price)}</span>
              <span>{trade.quantity.toFixed(3)}</span>
              <span>{formatTime(trade.time)}</span>
            </div>
          ))}
    </div>
  );
}
