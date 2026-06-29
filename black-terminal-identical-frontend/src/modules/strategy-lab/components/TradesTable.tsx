import { useMemo, useState } from "react";
import type { TradeDirection, TradeResult } from "../types/backtest.types";
import { formatCurrency, formatDateTime, formatDuration, formatNumber, formatPercent } from "./format";

type TradeFilter = "all" | "long" | "short" | "winners" | "losers";

type TradesTableProps = {
  trades: TradeResult[];
  onTradeSelect?: (trade: TradeResult) => void;
};

export function TradesTable({ trades, onTradeSelect }: TradesTableProps) {
  const [filter, setFilter] = useState<TradeFilter>("all");
  const [exitReason, setExitReason] = useState("all");
  const [direction, setDirection] = useState<TradeDirection | "all">("all");

  const exitReasons = useMemo(() => ["all", ...Array.from(new Set(trades.map((trade) => trade.exitReason)))], [trades]);
  const filtered = useMemo(() => trades.filter((trade) => {
    if (filter === "winners" && trade.pnl <= 0) return false;
    if (filter === "losers" && trade.pnl >= 0) return false;
    if (filter === "long" && trade.direction !== "long") return false;
    if (filter === "short" && trade.direction !== "short") return false;
    if (direction !== "all" && trade.direction !== direction) return false;
    if (exitReason !== "all" && trade.exitReason !== exitReason) return false;
    return true;
  }), [direction, exitReason, filter, trades]);

  return (
    <div className="strategy-panel trades-panel">
      <div className="strategy-panel-head">
        <span>TRADES</span>
        <b>{filtered.length} / {trades.length}</b>
      </div>
      <div className="strategy-table-filters">
        {(["all", "long", "short", "winners", "losers"] as TradeFilter[]).map((item) => (
          <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
            {item.toUpperCase()}
          </button>
        ))}
        <select value={direction} onChange={(event) => setDirection(event.target.value as TradeDirection | "all")}>
          <option value="all">Direction</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <select value={exitReason} onChange={(event) => setExitReason(event.target.value)}>
          {exitReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select>
      </div>
      <div className="strategy-table-wrap">
        <table className="strategy-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Dir</th>
              <th>Entry</th>
              <th>Entry Px</th>
              <th>Exit</th>
              <th>Exit Px</th>
              <th>Qty</th>
              <th>SL</th>
              <th>TP</th>
              <th>Fees</th>
              <th>Slip</th>
              <th>PnL</th>
              <th>PnL %</th>
              <th>R</th>
              <th>Reason</th>
              <th>Duration</th>
              <th>Signal</th>
              <th>Regime</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={18} className="strategy-empty-cell">NO TRADES</td></tr>
            ) : filtered.map((trade) => (
              <tr key={trade.id} className={trade.pnl >= 0 ? "win" : "loss"} onClick={() => onTradeSelect?.(trade)}>
                <td>{trade.id}</td>
                <td>{trade.direction}</td>
                <td>{formatDateTime(trade.entryTime)}</td>
                <td>{formatNumber(trade.entryPrice)}</td>
                <td>{formatDateTime(trade.exitTime)}</td>
                <td>{formatNumber(trade.exitPrice)}</td>
                <td>{formatNumber(trade.quantity, 5)}</td>
                <td>{trade.stopLoss ? formatNumber(trade.stopLoss) : "-"}</td>
                <td>{trade.takeProfit ? formatNumber(trade.takeProfit) : "-"}</td>
                <td>{formatCurrency(trade.fees)}</td>
                <td>{formatNumber(trade.slippage)}</td>
                <td>{formatCurrency(trade.pnl)}</td>
                <td>{formatPercent(trade.pnlPercent)}</td>
                <td>{formatNumber(trade.rMultiple)}</td>
                <td>{trade.exitReason}</td>
                <td>{formatDuration(trade.durationSeconds)}</td>
                <td>{trade.signalName}</td>
                <td>{trade.marketRegime ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
