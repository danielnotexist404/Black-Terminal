import { Pause, Play, RotateCcw, WalletCards } from "lucide-react";
import { isLocalOnlyRuntime } from "../../../../core/local-runtime/localRuntimeClient";
import type { StrategyPaperAccount } from "../../automation/strategyAutomation.types";

type Props = {
  paper: StrategyPaperAccount | null;
  data: Record<string, unknown> | null;
  busy: boolean;
  onAction: (action: "start" | "pause" | "top-up" | "reset", body?: Record<string, unknown>) => void;
};

export function PaperCockpit({ paper, data, busy, onAction }: Props) {
  if (!paper) return <div className="cockpit-empty-state"><strong>No Paper account yet</strong><span>Publish a certified draft before starting Paper Trading.</span></div>;
  const analytics = object(data?.analytics);
  const positions = list(data?.positions);
  const orders = list(data?.orders);
  const trades = list(data?.trades);
  const running = paper.status === "ACTIVE";
  return <div className="paper-cockpit">
    <div className="cockpit-metric-grid">
      <Metric label="PAPER EQUITY" value={money(paper.demoEquity + paper.realizedPnl + paper.unrealizedPnl - paper.fees - paper.funding)} />
      <Metric label="AVAILABLE EQUITY" value={money(paper.availableBalance)} />
      <Metric label="ALLOCATION" value={formatAllocation(paper)} />
      <Metric label="LEVERAGE" value={`${paper.preview.effectiveLeverage.toFixed(1)}x`} />
      <Metric label="OPEN POSITIONS" value={String(positions.length)} />
      <Metric label="OPEN ORDERS" value={String(orders.filter((item) => !["filled", "cancelled", "rejected"].includes(String(item.status).toLowerCase())).length)} />
      <Metric label="CLOSED TRADES" value={String(trades.length)} />
      <Metric label="NET PNL" value={signedMoney(Number(analytics.netPnl || paper.realizedPnl + paper.unrealizedPnl - paper.fees - paper.funding))} />
      <Metric label="DRAWDOWN" value={`${Number(analytics.maxDrawdownPercent || paper.maximumDrawdownPercent || 0).toFixed(2)}%`} />
      <Metric label="WIN RATE" value={`${Number(analytics.winRate || 0).toFixed(2)}%`} />
      <Metric label="SHARPE" value={Number(analytics.sharpe || 0).toFixed(2)} />
      <Metric label="SORTINO" value={Number(analytics.sortino || 0).toFixed(2)} />
    </div>
    <div className="paper-actions"><span><WalletCards size={14} /> Runs securely on {isLocalOnlyRuntime() ? "this device" : "Black Cloud"} · {paper.status.replaceAll("_", " ")}</span><button type="button" disabled={busy} onClick={() => onAction(running ? "pause" : "start")}>{running ? <Pause size={12} /> : <Play size={12} />}{running ? "PAUSE PAPER" : "START PAPER"}</button><button type="button" disabled={busy} onClick={() => onAction("top-up", { amount: 10_000 })}>TOP UP 10,000 USDT</button><button type="button" disabled={busy} onClick={() => onAction("reset", { demoEquity: 10_000 })}><RotateCcw size={12} /> RESET</button></div>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value as Array<Record<string, unknown>> : []; }
function formatAllocation(paper: StrategyPaperAccount) { const policy = paper.capitalPolicy; return policy.strategyAllocationMode === "FIXED_USDT" ? money(policy.strategyAllocationValue) : `${policy.strategyAllocationValue}%`; }
function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function signedMoney(value: number) { return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
