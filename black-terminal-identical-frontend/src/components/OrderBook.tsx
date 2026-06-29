import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { getPublicMarketDataAdapter } from "../market-data/exchangeRegistry";
import {
  MarketDataSubscription,
  MarketSymbol,
  OrderBookLevel,
  OrderBookSnapshot,
  TickerSnapshot,
  TradeTick
} from "../market-data/types";

type OrderBookProps = {
  marketSymbol: MarketSymbol;
  lastPrice: number;
  exchangeLabel: string;
};

type BookRow = OrderBookLevel & {
  total: number;
};

type ActiveBookTab = "DOM" | "ORDER BOOK" | "TRADES" | "TICKER";

type BookEnergyStyle = CSSProperties & {
  "--book-energy": string;
  "--book-opacity": string;
};

const tabs: ActiveBookTab[] = ["DOM", "ORDER BOOK", "TRADES", "TICKER"];

function fallbackBook(marketSymbol: MarketSymbol, price: number): OrderBookSnapshot {
  const center = Number.isFinite(price) && price > 0 ? price : 66678.1;
  return {
    exchange: marketSymbol.exchange,
    symbol: marketSymbol.rawSymbol,
    time: Math.floor(Date.now() / 1000),
    asks: Array.from({ length: 20 }).map((_, index) => ({
      price: center + 0.4 + index * 0.4,
      quantity: 4.2 + index * 0.72
    })),
    bids: Array.from({ length: 20 }).map((_, index) => ({
      price: center - 0.4 - index * 0.4,
      quantity: 5.6 + index * 0.79
    }))
  };
}

function withTotals(levels: OrderBookLevel[]) {
  let running = 0;
  return levels.map((level) => {
    running += level.quantity;
    return { ...level, total: running };
  });
}

function formatPrice(price?: number) {
  if (!Number.isFinite(price)) return "--";
  return price!.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function formatSize(value?: number, digits = 3) {
  if (!Number.isFinite(value)) return "--";
  return value!.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatCompact(value?: number) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value!);
}

function formatTime(time?: number) {
  if (!time) return "--";
  return new Date(time * 1000).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function signed(value?: number, suffix = "") {
  if (!Number.isFinite(value)) return "--";
  const sign = value! > 0 ? "+" : "";
  return `${sign}${value!.toFixed(2)}${suffix}`;
}

function toTickerFallback(
  marketSymbol: MarketSymbol,
  book: OrderBookSnapshot,
  trades: TradeTick[],
  lastPrice: number
): TickerSnapshot {
  const lastTrade = trades[0];
  return {
    exchange: marketSymbol.exchange,
    symbol: marketSymbol.rawSymbol,
    time: lastTrade?.time ?? book.time,
    lastPrice: lastTrade?.price ?? lastPrice,
    bidPrice: book.bids[0]?.price,
    askPrice: book.asks[0]?.price,
    bidQuantity: book.bids[0]?.quantity,
    askQuantity: book.asks[0]?.quantity
  };
}

export function OrderBook({ marketSymbol, lastPrice, exchangeLabel }: OrderBookProps) {
  const [book, setBook] = useState<OrderBookSnapshot>(() => fallbackBook(marketSymbol, lastPrice));
  const [trades, setTrades] = useState<TradeTick[]>([]);
  const [ticker, setTicker] = useState<TickerSnapshot | null>(null);
  const [bookStatus, setBookStatus] = useState("CONNECTING");
  const [tradeStatus, setTradeStatus] = useState("CONNECTING");
  const [tickerStatus, setTickerStatus] = useState("CONNECTING");
  const [activeTab, setActiveTab] = useState<ActiveBookTab>("DOM");

  useEffect(() => {
    let bookSubscription: MarketDataSubscription<OrderBookSnapshot> | undefined;
    let tradeSubscription: MarketDataSubscription<TradeTick> | undefined;
    let bookPollTimer: number | undefined;
    let tradePollTimer: number | undefined;
    let tickerPollTimer: number | undefined;
    let disposed = false;
    const seenTrades = new Set<string>();
    const seenTradeOrder: string[] = [];
    const adapter = getPublicMarketDataAdapter(marketSymbol.exchange);

    setBookStatus("CONNECTING");
    setTradeStatus("CONNECTING");
    setTickerStatus("CONNECTING");
    setBook(fallbackBook(marketSymbol, lastPrice));
    setTrades([]);
    setTicker(null);

    const pushTrades = (nextTrades: TradeTick[], status: string) => {
      const unseen = nextTrades.filter((trade) => {
        if (seenTrades.has(trade.tradeId)) return false;
        seenTrades.add(trade.tradeId);
        seenTradeOrder.push(trade.tradeId);
        if (seenTradeOrder.length > 3000) {
          const expired = seenTradeOrder.shift();
          if (expired) seenTrades.delete(expired);
        }
        return true;
      });
      if (unseen.length === 0) return;

      setTradeStatus(status);
      setTrades((current) =>
        [...unseen, ...current]
          .sort((a, b) => b.time - a.time || b.tradeId.localeCompare(a.tradeId))
          .slice(0, 80)
      );
    };

    const pollBook = () => {
      if (!adapter?.getOrderBookSnapshot) {
        if (!disposed) setBookStatus("BOOK FALLBACK");
        return;
      }

      adapter
        .getOrderBookSnapshot(marketSymbol, 50)
        .then((snapshot) => {
          if (disposed) return;
          setBook(snapshot);
          setBookStatus((current) => (current === "LIVE BOOK" ? current : "REST BOOK"));
        })
        .catch((err: unknown) => {
          console.error(`${adapter.label} order book REST heartbeat failed`, err);
          if (!disposed) setBookStatus("BOOK FALLBACK");
        });
    };

    const pollTrades = () => {
      if (!adapter?.getRecentTrades) {
        if (!disposed) setTradeStatus("TAPE FALLBACK");
        return;
      }

      adapter
        .getRecentTrades(marketSymbol, 50)
        .then((nextTrades) => {
          if (!disposed) pushTrades(nextTrades, "REST TRADES");
        })
        .catch((err: unknown) => {
          console.error(`${adapter.label} trades REST heartbeat failed`, err);
          if (!disposed) setTradeStatus("TRADES FALLBACK");
        });
    };

    const pollTicker = () => {
      if (!adapter?.getTickerSnapshot) {
        if (!disposed) setTickerStatus("DERIVED");
        return;
      }

      adapter
        .getTickerSnapshot(marketSymbol)
        .then((snapshot) => {
          if (disposed) return;
          setTicker(snapshot);
          setTickerStatus("REST TICKER");
        })
        .catch((err: unknown) => {
          console.error(`${adapter.label} ticker REST heartbeat failed`, err);
          if (!disposed) setTickerStatus("DERIVED");
        });
    };

    bookSubscription = adapter?.subscribeOrderBook?.(marketSymbol, (nextBook) => {
      setBook(nextBook);
      setBookStatus("LIVE BOOK");
    });

    tradeSubscription = adapter?.subscribeTrades?.(marketSymbol, (trade) => {
      pushTrades([trade], "LIVE TRADES");
    });

    bookSubscription?.onError((err) => {
      console.error(`${adapter?.label ?? exchangeLabel} order book stream failed`, err);
      if (disposed) return;
      if (!disposed) setBookStatus("REST BOOK");
      if (!bookPollTimer) {
        pollBook();
        bookPollTimer = window.setInterval(pollBook, 1000);
      }
    });

    tradeSubscription?.onError((err) => {
      console.error(`${adapter?.label ?? exchangeLabel} trades stream failed`, err);
      if (disposed) return;
      if (!disposed) setTradeStatus("REST TRADES");
      if (!tradePollTimer) {
        pollTrades();
        tradePollTimer = window.setInterval(pollTrades, 1000);
      }
    });

    pollBook();
    pollTrades();
    pollTicker();
    if (!bookSubscription) bookPollTimer = window.setInterval(pollBook, 1000);
    if (!tradeSubscription) tradePollTimer = window.setInterval(pollTrades, 1000);
    tickerPollTimer = window.setInterval(pollTicker, 2500);

    return () => {
      disposed = true;
      bookSubscription?.unsubscribe();
      tradeSubscription?.unsubscribe();
      if (bookPollTimer) window.clearInterval(bookPollTimer);
      if (tradePollTimer) window.clearInterval(tradePollTimer);
      if (tickerPollTimer) window.clearInterval(tickerPollTimer);
    };
  }, [
    marketSymbol.exchange,
    marketSymbol.rawSymbol,
    marketSymbol.marketKind,
    marketSymbol.baseAsset,
    marketSymbol.quoteAsset,
    exchangeLabel,
  ]);

  const asksDom = useMemo(() => withTotals(book.asks.slice(0, 8)).reverse(), [book.asks]);
  const bidsDom = useMemo(() => withTotals(book.bids.slice(0, 8)), [book.bids]);
  const asksDepth = useMemo(() => withTotals(book.asks.slice(0, 20)), [book.asks]);
  const bidsDepth = useMemo(() => withTotals(book.bids.slice(0, 20)), [book.bids]);
  const tickerView = ticker ?? toTickerFallback(marketSymbol, book, trades, lastPrice);
  const bestAsk = tickerView.askPrice ?? book.asks[0]?.price ?? lastPrice;
  const bestBid = tickerView.bidPrice ?? book.bids[0]?.price ?? lastPrice;
  const mid = (bestAsk + bestBid) / 2;
  const spread = Math.max(0, bestAsk - bestBid);
  const domMaxTotal = Math.max(...asksDom.map((row) => row.total), ...bidsDom.map((row) => row.total), 1);
  const domMaxQuantity = Math.max(...asksDom.map((row) => row.quantity), ...bidsDom.map((row) => row.quantity), 1);
  const depthMaxTotal = Math.max(...asksDepth.map((row) => row.total), ...bidsDepth.map((row) => row.total), 1);
  const bidDepthQuantity = bidsDepth.reduce((sum, row) => sum + row.quantity, 0);
  const askDepthQuantity = asksDepth.reduce((sum, row) => sum + row.quantity, 0);
  const depthTotal = bidDepthQuantity + askDepthQuantity;
  const bidImbalance = depthTotal ? (bidDepthQuantity / depthTotal) * 100 : 50;
  const activeStatus = activeTab === "TRADES" ? tradeStatus : activeTab === "TICKER" ? tickerStatus : bookStatus;

  const renderDomRow = (row: BookRow, side: "ask" | "bid") => {
    const totalRatio = Math.max(0.002, Math.min(1, row.total / domMaxTotal));
    const sizeRatio = Math.max(0.06, Math.min(1, row.quantity / domMaxQuantity));
    const style: BookEnergyStyle = {
      "--book-energy": Math.pow(totalRatio, 0.82).toFixed(4),
      "--book-opacity": (0.18 + sizeRatio * 0.66).toFixed(3)
    };

    return (
      <div className={`book-row ${side}`} key={`${side}-${row.price}`}>
        <span>{formatPrice(row.price)}</span>
        <span>{formatSize(row.quantity)}</span>
        <span>{formatSize(row.total)}</span>
        <i style={style} />
      </div>
    );
  };

  const renderDom = () => (
    <div className="book-view dom-view">
      <div className="book-head">
        <span>Price ({marketSymbol.quoteAsset})</span>
        <span>Size ({marketSymbol.baseAsset})</span>
        <span>Total ({marketSymbol.baseAsset})</span>
      </div>
      {asksDom.map((row) => renderDomRow(row, "ask"))}
      <div className="mid-price">
        <strong>{formatPrice(tickerView.lastPrice)}</strong>
        <span>{tickerView.lastPrice >= mid ? "UP" : "DOWN"} {(tickerView.lastPrice - mid).toFixed(1)}</span>
        <em>
          SPREAD {spread.toFixed(2)} ({mid > 0 ? ((spread / mid) * 100).toFixed(3) : "0.000"}%)
        </em>
      </div>
      {bidsDom.map((row) => renderDomRow(row, "bid"))}
    </div>
  );

  const renderDepth = () => {
    const rowCount = Math.max(asksDepth.length, bidsDepth.length, 1);
    return (
      <div className="book-view depth-view">
        <div className="depth-summary">
          <span>BID DEPTH {formatSize(bidDepthQuantity, 2)}</span>
          <i>
            <b style={{ width: `${bidImbalance}%` }} />
          </i>
          <span>ASK DEPTH {formatSize(askDepthQuantity, 2)}</span>
        </div>
        <div className="depth-head">
          <span>Bid Size</span>
          <span>Bid Price</span>
          <span>Ask Price</span>
          <span>Ask Size</span>
        </div>
        {Array.from({ length: Math.min(rowCount, 18) }).map((_, index) => {
          const bid = bidsDepth[index];
          const ask = asksDepth[index];
          const bidEnergy = bid ? Math.max(0.02, bid.total / depthMaxTotal) : 0;
          const askEnergy = ask ? Math.max(0.02, ask.total / depthMaxTotal) : 0;
          return (
            <div className="depth-row" key={`${bid?.price ?? "b"}-${ask?.price ?? "a"}-${index}`}>
              <i className="depth-energy bid" style={{ transform: `scaleX(${bidEnergy})` }} />
              <i className="depth-energy ask" style={{ transform: `scaleX(${askEnergy})` }} />
              <span>{bid ? formatSize(bid.quantity) : "--"}</span>
              <span className="green">{bid ? formatPrice(bid.price) : "--"}</span>
              <span className="red">{ask ? formatPrice(ask.price) : "--"}</span>
              <span>{ask ? formatSize(ask.quantity) : "--"}</span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderTrades = () => (
    <div className="book-view terminal-trades">
      <div className="trade-head">
        <span>Price</span>
        <span>Size</span>
        <span>Notional</span>
        <span>Time</span>
      </div>
      {trades.length === 0
        ? Array.from({ length: 12 }).map((_, index) => (
            <div className="terminal-trade-row" key={index}>
              <span>--</span>
              <span>--</span>
              <span>--</span>
              <span>--</span>
            </div>
          ))
        : trades.slice(0, 30).map((trade) => (
            <div className={`terminal-trade-row ${trade.side}`} key={trade.tradeId}>
              <span>{formatPrice(trade.price)}</span>
              <span>{formatSize(trade.quantity)}</span>
              <span>{formatCompact(trade.price * trade.quantity)}</span>
              <span>{formatTime(trade.time)}</span>
            </div>
          ))}
    </div>
  );

  const renderTicker = () => {
    const changeClass = (tickerView.priceChange ?? 0) >= 0 ? "green" : "red";
    const rows = [
      ["Last", formatPrice(tickerView.lastPrice), changeClass],
      ["24H Change", signed(tickerView.priceChange), changeClass],
      ["24H Change %", signed(tickerView.priceChangePercent, "%"), changeClass],
      ["Best Bid", `${formatPrice(bestBid)} / ${formatSize(tickerView.bidQuantity)}`, "green"],
      ["Best Ask", `${formatPrice(bestAsk)} / ${formatSize(tickerView.askQuantity)}`, "red"],
      ["Spread", `${spread.toFixed(2)} (${mid > 0 ? ((spread / mid) * 100).toFixed(3) : "0.000"}%)`, ""],
      ["24H High", formatPrice(tickerView.highPrice), ""],
      ["24H Low", formatPrice(tickerView.lowPrice), ""],
      [`Volume (${marketSymbol.baseAsset})`, formatCompact(tickerView.volume), ""],
      [`Volume (${marketSymbol.quoteAsset})`, formatCompact(tickerView.quoteVolume), ""],
      ["Last Update", formatTime(tickerView.time), ""]
    ];

    return (
      <div className="book-view ticker-view">
        <div className="ticker-hero">
          <span>{exchangeLabel.toUpperCase()} {`${marketSymbol.baseAsset}${marketSymbol.quoteAsset}`}</span>
          <strong>{formatPrice(tickerView.lastPrice)}</strong>
          <em className={changeClass}>{signed(tickerView.priceChangePercent, "%")}</em>
        </div>
        <div className="ticker-grid">
          {rows.map(([label, value, className]) => (
            <div className="ticker-cell" key={label}>
              <span>{label}</span>
              <b className={className}>{value}</b>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="orderbook panel-block">
      <div className="tabs">
        {tabs.map((tab) => (
          <button key={tab} className={tab === activeTab ? "active" : ""} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="book-status">{activeStatus}</div>
      <div className="book-body">
        {activeTab === "DOM" && renderDom()}
        {activeTab === "ORDER BOOK" && renderDepth()}
        {activeTab === "TRADES" && renderTrades()}
        {activeTab === "TICKER" && renderTicker()}
      </div>
    </div>
  );
}
