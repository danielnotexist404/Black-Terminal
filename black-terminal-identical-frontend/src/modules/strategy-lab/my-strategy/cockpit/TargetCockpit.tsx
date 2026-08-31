import { AlertOctagon, Link2Off, Pause, Pencil, Play, ShieldCheck } from "lucide-react";
import type { StrategyTargetBinding, StrategyTargetSnapshot } from "../../automation/strategyAutomation.types";
import { targetExecutionFailure } from "./targetExecutionPresentation";

export function TargetCockpit({ binding, snapshot, busy, onAction, onModify, onDisconnect }: { binding: StrategyTargetBinding; snapshot?: StrategyTargetSnapshot; busy: boolean; onAction: (action: "arm" | "pause" | "resume") => void; onModify: () => void; onDisconnect: () => void }) {
  const environment = binding.executionEnvironment || (binding.targetType === "INVESTMENT_GROUP" ? "INVESTMENT_GROUP" : "BROKER");
  const environmentLabel = environment === "MAINNET_LIVE" ? "BYBIT MAINNET" : environment === "DEMO" ? "BYBIT DEMO" : environment.replaceAll("_", " ");
  const activeLabel = binding.status === "LIVE" ? `${environmentLabel} EXECUTION ACTIVE` : `${environmentLabel} EXECUTION PAUSED`;
  const scope = environment === "MAINNET_LIVE"
    ? "Real-funds orders are routed only after target arming, closed-candle confirmation, mandate, risk, fencing and idempotency checks. Withdrawals and transfers are prohibited."
    : environment === "DEMO"
      ? "Simulated funds use Bybit Demo execution with mainnet public market data. Withdrawals and transfers are prohibited."
      : "Signed strategy intents fan out only to active follower mandates; every account keeps its own allocation, risk limits and execution control.";
  const executionFailure = targetExecutionFailure(snapshot);
  const executionContext = [executionFailure?.direction, executionFailure?.action].filter(Boolean).join(" ");
  return <section className="target-cockpit">
    <header><div><span>TARGET {String(binding.slotIndex).padStart(2, "0")}</span><h2>{binding.targetLabel || binding.targetProvider || binding.targetType}</h2><p>{environmentLabel} · {binding.marketType} · {binding.status}</p></div><div className="target-cockpit-actions"><button type="button" disabled={busy || !["READY", "LIVE", "PAUSED", "DEGRADED"].includes(binding.status)} onClick={() => onAction(binding.status === "READY" ? "arm" : binding.status === "PAUSED" ? "resume" : "pause")}>{binding.status === "READY" || binding.status === "PAUSED" ? <Play size={12} /> : <Pause size={12} />}{binding.status === "READY" ? "ACTIVATE" : binding.status === "PAUSED" ? "REVALIDATE" : "PAUSE"}</button>{binding.targetType === "BROKER_ACCOUNT" ? <button type="button" disabled={busy} onClick={onModify}><Pencil size={12} /> MODIFY</button> : null}<button type="button" disabled={busy} onClick={onDisconnect}><Link2Off size={12} /> REMOVE</button></div></header>
    {executionFailure ? <div className="target-execution-failure" role="alert"><AlertOctagon size={22} aria-hidden="true" /><div><span>EXECUTION FAILED · {executionContext || "BROKER COMMAND"} · {executionFailure.occurredAt}</span><strong>{executionFailure.errorMessage}</strong>{executionFailure.errorCode ? <code>{executionFailure.errorCode}</code> : null}{executionFailure.noVenueOrderSubmitted ? <b>NO VENUE ORDER WAS SUBMITTED.</b> : null}</div></div> : null}
    <div className="cockpit-metric-grid target-metrics"><Metric label="FRESHNESS" value={snapshot?.freshness || "UNAVAILABLE"} /><Metric label="EQUITY" value={money(snapshot?.equity || 0)} /><Metric label="ALLOCATED" value={money(snapshot?.allocatedStrategyCapital || 0)} /><Metric label="USED" value={money(snapshot?.usedStrategyCapital || 0)} /><Metric label="OPEN POSITIONS" value={String(snapshot?.openPositions || 0)} /><Metric label="OPEN ORDERS" value={String(snapshot?.openOrders || 0)} /><Metric label="NET PNL" value={signedMoney(snapshot?.netPnl || 0)} /><Metric label="DRAWDOWN" value={`${(snapshot?.currentDrawdownPercent || 0).toFixed(2)}%`} /></div>
    <div className="target-policy-grid"><div><span>Strategy allocation</span><strong>{binding.capitalPolicy.strategyAllocationValue}{binding.capitalPolicy.strategyAllocationMode === "FIXED_USDT" ? " USDT" : "%"}</strong></div><div><span>Per-trade amount</span><strong>{binding.capitalPolicy.tradeAmountValue}{binding.capitalPolicy.tradeAmountMode === "FIXED_USDT" ? " USDT" : "%"}</strong></div><div><span>Connection</span><strong>{snapshot?.connectionHealth || "Unavailable"}</strong></div><div><span>Protection</span><strong>{snapshot?.protectionHealth || "Not armed"}</strong></div></div>
    <div className="live-certification-banner demo-ready"><ShieldCheck size={14} /><div><strong>{activeLabel}</strong><span>{scope}</span></div></div>
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function signedMoney(value: number) { return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
