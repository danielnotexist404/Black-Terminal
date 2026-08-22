import { MoreHorizontal, Pause, Play, Square, SlidersHorizontal } from "lucide-react";
import type { StrategyWorkspace } from "../../automation/strategyAutomation.types";

type Props = {
  workspace: StrategyWorkspace;
  busy: boolean;
  onEdit: () => void;
  onPaperAction: (action: "start" | "pause") => void;
};

export function StrategyHeader({ workspace, busy, onEdit, onPaperAction }: Props) {
  const { strategy, runtime, paper } = workspace;
  const running = paper?.status === "ACTIVE" || strategy.status === "PAPER_ACTIVE";
  const health = runtimeHealth(runtime?.state, runtime?.lastHeartbeatAt);
  return <header className="strategy-cockpit-header">
    <div className="strategy-cockpit-title">
      <span>{running ? "PAPER · RUNNING" : strategy.runningVersion ? "PAPER · PAUSED" : "PAPER · NOT STARTED"}</span>
      <h1>{strategy.name}</h1>
      <p>{strategy.symbol} · {strategy.timeframe.toUpperCase()} · {title(strategy.marketType)} · Version {strategy.runningVersion || strategy.publishedVersion || "—"}</p>
    </div>
    <div className="strategy-runtime-health" data-tone={health.tone}>
      <span>VPS RUNTIME</span><strong>{health.label}</strong><em>Last heartbeat {relative(runtime?.lastHeartbeatAt)}</em>
    </div>
    <div className="strategy-cockpit-actions">
      <button type="button" disabled={busy || !strategy.runningVersion} onClick={() => onPaperAction(running ? "pause" : "start")}>{running ? <Pause size={13} /> : <Play size={13} />}{running ? "PAUSE" : "START"}</button>
      <button type="button" disabled title="Stop requires an explicit flat-position policy"><Square size={12} /> STOP</button>
      <button type="button" onClick={onEdit}><SlidersHorizontal size={13} /> EDIT CONFIGURATION</button>
      <button type="button" aria-label="More strategy actions"><MoreHorizontal size={15} /></button>
    </div>
  </header>;
}

function runtimeHealth(state?: string, heartbeat?: string) {
  if (!state) return { label: "Not started", tone: "neutral" };
  if (heartbeat && Date.now() - Date.parse(heartbeat) > 90_000) return { label: "Recovering", tone: "warning" };
  if (["ERROR", "DEGRADED"].includes(state)) return { label: "Degraded", tone: "warning" };
  return { label: "Healthy", tone: "positive" };
}
function relative(value?: string) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
function title(value: string) { return value.slice(0, 1) + value.slice(1).toLowerCase(); }
