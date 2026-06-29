import type { BacktestResult } from "../types/backtest.types";
import { formatCurrency, formatPercent } from "./format";

type ForwardTestPanelProps = {
  result?: BacktestResult;
  symbol: string;
};

export function ForwardTestPanel({ result, symbol }: ForwardTestPanelProps) {
  return (
    <div className="strategy-panel forward-panel">
      <div className="strategy-panel-head">
        <span>FORWARD TEST</span>
        <b>LOCAL PAPER</b>
      </div>
      <div className="forward-grid">
        <div>
          <span>Strategy Status</span>
          <strong>ARMED</strong>
        </div>
        <div>
          <span>Symbol</span>
          <strong>{symbol}</strong>
        </div>
        <div>
          <span>Current Signal</span>
          <strong>WAITING</strong>
        </div>
        <div>
          <span>Open Position</span>
          <strong>FLAT</strong>
        </div>
        <div>
          <span>Unrealized PnL</span>
          <strong>{formatCurrency(0)}</strong>
        </div>
        <div>
          <span>Backtest Expectancy</span>
          <strong>{result ? formatCurrency(result.metrics.expectancy) : "-"}</strong>
        </div>
        <div>
          <span>Backtest Win Rate</span>
          <strong>{result ? formatPercent(result.metrics.winRate) : "-"}</strong>
        </div>
        <div>
          <span>Alerts</span>
          <strong>LOCAL</strong>
        </div>
      </div>
      <div className="strategy-note">TODO: connect this panel to live/replay strategy simulation and paper trade state.</div>
    </div>
  );
}
