import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  MarketSymbol,
  OrderBookLevel,
  OrderBookSnapshot,
  TickerSnapshot,
  TradeTick
} from "../market-data/types";
import { useDomFeed } from "../modules/dom-pro/useDomFeed";

type OrderBookProps = {
  marketSymbol: MarketSymbol;
  lastPrice: number;
  exchangeLabel: string;
  onOpenDomPro?: (mode?: "expanded" | "detached-browser", options?: { openSettings?: boolean }) => void;
  onResetDomLayout?: () => void;
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
  book: OrderBookSnapshot | null,
  trades: TradeTick[],
  lastPrice: number
): TickerSnapshot {
  const lastTrade = trades[0];
  return {
    exchange: marketSymbol.exchange,
    symbol: marketSymbol.rawSymbol,
    time: lastTrade?.time ?? book?.time ?? Math.floor(Date.now() / 1000),
    lastPrice: lastTrade?.price ?? lastPrice,
    bidPrice: book?.bids[0]?.price,
    askPrice: book?.asks[0]?.price,
    bidQuantity: book?.bids[0]?.quantity,
    askQuantity: book?.asks[0]?.quantity
  };
}

export function OrderBook({ marketSymbol, lastPrice, exchangeLabel, onOpenDomPro, onResetDomLayout }: OrderBookProps) {
  const feed = useDomFeed(marketSymbol);
  const book = feed.book;
  const trades = feed.trades;
  const ticker = feed.ticker;
  const bookStatus = feed.bookStatus;
  const tradeStatus = feed.tradeStatus;
  const tickerStatus = feed.tickerStatus;
  const [activeTab, setActiveTab] = useState<ActiveBookTab>("DOM");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const asksDom = useMemo(() => withTotals(book?.asks.slice(0, 8) ?? []).reverse(), [book]);
  const bidsDom = useMemo(() => withTotals(book?.bids.slice(0, 8) ?? []), [book]);
  const asksDepth = useMemo(() => withTotals(book?.asks.slice(0, 20) ?? []), [book]);
  const bidsDepth = useMemo(() => withTotals(book?.bids.slice(0, 20) ?? []), [book]);
  const tickerView = ticker ?? toTickerFallback(marketSymbol, book, trades, lastPrice);
  const bestAsk = tickerView.askPrice ?? book?.asks[0]?.price ?? lastPrice;
  const bestBid = tickerView.bidPrice ?? book?.bids[0]?.price ?? lastPrice;
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
      {!book && <div className="book-empty">Awaiting live orderbook stream.</div>}
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
        {!book && <div className="book-empty">Awaiting live orderbook stream.</div>}
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
        ? <div className="book-empty">Trade stream unavailable for this venue.</div>
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
    <div
      className="orderbook panel-block"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onMouseLeave={() => setMenu(null)}
    >
      <div className="tabs dom-compact-tabs">
        {tabs.map((tab) => (
          <button key={tab} className={tab === activeTab ? "active" : ""} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
        <button
          type="button"
          className="dom-pro-open"
          title="Open DOM Pro+"
          onClick={() => onOpenDomPro?.("expanded")}
        >
          PRO+
        </button>
      </div>
      <div className="book-status">{activeStatus}</div>
      {menu && (
        <div className="dom-compact-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => { setMenu(null); onOpenDomPro?.("expanded"); }}>Open DOM Pro+</button>
          <button type="button" onClick={() => { setMenu(null); onOpenDomPro?.("detached-browser"); }}>Detach DOM</button>
          <button type="button" onClick={() => { setMenu(null); onOpenDomPro?.("detached-browser"); }}>Send to monitor</button>
          <button type="button" onClick={() => { setMenu(null); onResetDomLayout?.(); }}>Reset DOM layout</button>
          <button type="button" onClick={() => { setMenu(null); onOpenDomPro?.("expanded", { openSettings: true }); }}>DOM settings</button>
        </div>
      )}
      <div className="book-body">
        {activeTab === "DOM" && renderDom()}
        {activeTab === "ORDER BOOK" && renderDepth()}
        {activeTab === "TRADES" && renderTrades()}
        {activeTab === "TICKER" && renderTicker()}
      </div>
    </div>
  );
}
