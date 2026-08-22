import { Activity, LockKeyhole } from "lucide-react";
import type { StrategyWorkspace } from "../../automation/strategyAutomation.types";
import { RuntimeTimeline } from "./RuntimeTimeline";
import { TargetSlotMatrix } from "./TargetSlotMatrix";

export function StrategyOverview({ workspace, paperData, onAddTarget }: { workspace: StrategyWorkspace; paperData: Record<string, unknown> | null; onAddTarget: (slot: number) => void }) {
  const paper = workspace.paper;
  const analytics = object(paperData?.analytics);
  const positions = list(paperData?.positions);
  const trades = list(paperData?.trades);
  const equity = paper ? paper.demoEquity + paper.realizedPnl + paper.unrealizedPnl - paper.fees - paper.funding : 0;
  const net = Number(analytics.netPnl || (paper ? paper.realizedPnl + paper.unrealizedPnl - paper.fees - paper.funding : 0));
  return <div className="strategy-overview">
    <div className="cockpit-metric-grid overview-metrics">
      <Metric label="EQUITY" value={money(equity)} />
      <Metric label="NET PNL" value={signedMoney(net)} tone={net >= 0 ? "positive" : "negative"} />
      <Metric label="CURRENT DRAWDOWN" value={`${Number(analytics.currentDrawdownPercent || 0).toFixed(2)}%`} />
      <Metric label="MAXIMUM DRAWDOWN" value={`${Number(analytics.maxDrawdownPercent || paper?.maximumDrawdownPercent || 0).toFixed(2)}%`} />
      <Metric label="WIN RATE" value={`${Number(analytics.winRate || 0).toFixed(2)}%`} />
      <Metric label="PROFIT FACTOR" value={finite(analytics.profitFactor)} />
      <Metric label="OPEN POSITIONS" value={String(positions.length)} />
      <Metric label="RUNTIME HEALTH" value={workspace.runtime?.state?.replaceAll("_", " ") || "NOT STARTED"} />
    </div>
    <div className="cockpit-overview-grid">
      <section className="cockpit-panel paper-target-summary"><header><span>PAPER TARGET</span><strong>{paper?.status?.replaceAll("_", " ") || "NOT CREATED"}</strong></header>{paper ? <><div><span>Available</span><b>{money(paper.availableBalance)}</b></div><div><span>Realized PnL</span><b>{signedMoney(paper.realizedPnl)}</b></div><div><span>Used capital</span><b>{money(paper.usedStrategyCapital)}</b></div></> : <p>Publish a certified version to create its Paper target.</p>}</section>
      <section className="cockpit-panel"><header><span>OPEN POSITION</span><strong>{positions.length}</strong></header>{positions[0] ? <PositionSummary value={positions[0]} /> : <div className="cockpit-empty-state compact"><strong>Flat</strong><span>No open Paper positions.</span></div>}</section>
      <section className="cockpit-panel"><header><span>RECENT TRADES</span><strong>{trades.length}</strong></header>{trades.length ? <div className="recent-trade-list">{trades.slice(0, 4).map((trade, index) => <div key={String(trade.id || index)}><span>{String(trade.symbol || workspace.strategy.symbol)} · {String(trade.direction || trade.side || "—")}</span><b>{signedMoney(Number(trade.net_pnl || trade.netPnl || 0))}</b></div>)}</div> : <div className="cockpit-empty-state compact"><strong>No Paper trades</strong><span>Accepted signals and fills will appear here.</span></div>}</section>
      <section className="cockpit-panel"><header><span>RISK STATE</span><strong>{paper?.status === "RISK_SUSPENDED" ? "SUSPENDED" : "WITHIN LIMITS"}</strong></header><div className="risk-state-summary"><Activity size={17} /><p>Maximum drawdown {paper?.capitalPolicy.maximumDrawdown || 0}% · Maximum exposure {paper?.capitalPolicy.maximumExposurePercent || 0}%</p></div></section>
    </div>
    <TargetSlotMatrix bindings={workspace.bindings} snapshots={workspace.snapshots} onAdd={onAddTarget} />
    <section className="cockpit-panel runtime-overview"><header><span>RUNTIME TIMELINE</span><strong>SYNCED WITH VPS</strong></header><RuntimeTimeline audit={workspace.audit} /></section>
    <div className="live-certification-banner"><LockKeyhole size={14} /><div><strong>LIVE TRADING NOT YET CERTIFIED</strong><span>Paper automation is enabled. Broker and Investment Group execution remain disabled.</span></div></div>
  </div>;
}

function PositionSummary({ value }: { value: Record<string, unknown> }) { return <div className="position-summary"><strong>{String(value.symbol || "—")}</strong><span>{String(value.direction || value.side || "—")} · {Number(value.quantity || value.size || 0)}</span><b>{signedMoney(Number(value.unrealized_pnl || value.unrealizedPnl || 0))}</b></div>; }
function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div><span>{label}</span><strong className={tone}>{value}</strong></div>; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value as Array<Record<string, unknown>> : []; }
function finite(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(2) : "—"; }
function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function signedMoney(value: number) { return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
