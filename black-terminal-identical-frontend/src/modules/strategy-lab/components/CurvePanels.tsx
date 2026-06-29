import type { DrawdownPoint, EquityPoint, PeriodBreakdown } from "../types/backtest.types";
import { formatCurrency, formatPercent } from "./format";

type CurvePanelProps = {
  title: string;
  points: Array<{ time: number; value: number }>;
  valueFormatter?: (value: number) => string;
  danger?: boolean;
};

function pathFor(points: Array<{ time: number; value: number }>, width: number, height: number) {
  if (points.length < 2) return "";
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * width;
    const y = height - ((point.value - min) / range) * height;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

export function CurvePanel({ title, points, valueFormatter = String, danger }: CurvePanelProps) {
  const width = 720;
  const height = 220;
  const last = points[points.length - 1]?.value ?? 0;
  const path = pathFor(points, width, height);

  return (
    <div className="strategy-panel curve-panel">
      <div className="strategy-panel-head">
        <span>{title}</span>
        <b>{valueFormatter(last)}</b>
      </div>
      {path ? (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={danger ? "danger" : ""}>
          <path className="curve-grid" d={`M 0 ${height * 0.25} H ${width} M 0 ${height * 0.5} H ${width} M 0 ${height * 0.75} H ${width}`} />
          <path className="curve-line" d={path} />
        </svg>
      ) : (
        <div className="strategy-empty-state">RUN A BACKTEST</div>
      )}
    </div>
  );
}

export function EquityCurvePanel({ points }: { points: EquityPoint[] }) {
  return <CurvePanel title="EQUITY CURVE" points={points.map((point) => ({ time: point.time, value: point.equity }))} valueFormatter={formatCurrency} />;
}

export function DrawdownCurvePanel({ points }: { points: DrawdownPoint[] }) {
  return <CurvePanel title="DRAWDOWN CURVE" points={points.map((point) => ({ time: point.time, value: -point.drawdownPercent }))} valueFormatter={(value) => formatPercent(Math.abs(value))} danger />;
}

export function PeriodPerformancePanel({ title, rows }: { title: string; rows: PeriodBreakdown[] }) {
  return (
    <div className="strategy-panel period-panel">
      <div className="strategy-panel-head">
        <span>{title}</span>
        <b>{rows.length}</b>
      </div>
      <div className="period-grid">
        {rows.length === 0 ? <div className="strategy-empty-state">NO PERIOD DATA</div> : rows.slice(-18).map((row) => (
          <div key={row.key} className={row.pnl >= 0 ? "period-cell win" : "period-cell loss"}>
            <span>{row.key}</span>
            <strong>{formatCurrency(row.pnl)}</strong>
            <em>{formatPercent(row.winRate)}</em>
          </div>
        ))}
      </div>
    </div>
  );
}
