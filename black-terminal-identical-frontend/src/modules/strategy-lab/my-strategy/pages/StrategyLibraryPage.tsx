import { Activity, FlaskConical, MoreHorizontal, Pause, Play, Plus } from "lucide-react";
import type { StrategySummary } from "../../automation/strategyAutomation.types";

type Props = {
  strategies: StrategySummary[];
  loading: boolean;
  message?: string;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onBacktest: (strategy: StrategySummary) => void;
  onPaperAction: (strategy: StrategySummary, action: "start" | "pause") => void;
  onOpenQalc: () => void;
};

export function StrategyLibraryPage({ strategies, loading, message, onCreate, onOpen, onBacktest, onPaperAction, onOpenQalc }: Props) {
  return (
    <section className="my-strategy-library" aria-label="My Strategy library">
      <header className="my-strategy-library-head">
        <div>
          <span>MY STRATEGY</span>
          <h1>Build, test and automate indicator-driven strategies.</h1>
          <p>Create with a guided workflow, then operate each published strategy from its own cockpit.</p>
        </div>
        <button type="button" className="strategy-primary-button" onClick={onCreate}><Plus size={15} /> CREATE NEW STRATEGY</button>
      </header>
      {message ? <div className="strategy-library-message" role="status">{message}</div> : null}
      <section className="qalc-template-card"><div><span>START FROM TEMPLATE / MICROSTRUCTURE</span><h2>BC-QALC — Queue-Aware Liquidity Capture</h2><p>Native event-driven Bybit order-book strategy with real aggressor flow, conservative queue fills, all-in cost gating and bounded Paper inventory.</p></div><div><b>PAPER CERTIFICATION REQUIRED</b><button type="button" onClick={onOpenQalc}>OPEN BC-QALC</button></div></section>
      {loading ? (
        <div className="strategy-library-empty"><Activity className="spin" size={22} /><strong>Loading strategies</strong><span>Restoring VPS strategy and Paper runtime state.</span></div>
      ) : strategies.length === 0 ? (
        <div className="strategy-library-empty">
          <FlaskConical size={28} />
          <strong>No strategies yet</strong>
          <span>Create a draft, map confirmed indicator alerts, and validate it in Paper Trading.</span>
          <button type="button" onClick={onCreate}><Plus size={14} /> CREATE YOUR FIRST STRATEGY</button>
        </div>
      ) : (
        <div className="strategy-library-grid">
          {strategies.map((strategy) => {
            const active = strategy.status === "PAPER_ACTIVE";
            const pnl = strategy.paperPnl || 0;
            return (
              <article className="strategy-library-card" key={strategy.id}>
                <div className="strategy-card-title">
                  <div><span>{statusLabel(strategy)}</span><h2>{strategy.name}</h2></div>
                  <button type="button" aria-label={`More actions for ${strategy.name}`}><MoreHorizontal size={16} /></button>
                </div>
                <p>{strategy.indicatorName || "Indicator not selected"} · {strategy.symbol} · {strategy.timeframe.toUpperCase()} · {titleCase(strategy.marketType)}</p>
                <div className="strategy-card-version">
                  <span>Published <b>{strategy.publishedVersion ? `V${strategy.publishedVersion}` : "—"}</b></span>
                  <span>Running <b>{strategy.runningVersion ? `V${strategy.runningVersion}` : "—"}</b></span>
                  {strategy.hasDraftChanges ? <em>{strategy.draftRevision} DRAFT</em> : null}
                </div>
                <div className="strategy-card-metrics">
                  <Metric label="EQUITY" value={money(strategy.paperEquity || 0)} />
                  <Metric label="NET PNL" value={signedMoney(pnl)} tone={pnl >= 0 ? "positive" : "negative"} />
                  <Metric label="DRAWDOWN" value={`-${(strategy.paperDrawdown || 0).toFixed(2)}%`} tone="negative" />
                  <Metric label="TRADES" value={String(strategy.paperTrades || 0)} />
                  <Metric label="LIVE TARGETS" value={`${strategy.connectedTargets || 0} / 10`} />
                  <Metric label="RUNTIME" value={humanState(strategy.runtimeState || "NOT STARTED")} />
                </div>
                <div className="strategy-card-last-signal"><span>Last signal</span><b>{strategy.lastSignalAt ? relativeTime(strategy.lastSignalAt) : "None yet"}</b></div>
                <div className="strategy-card-actions">
                  <button type="button" className="primary" onClick={() => onOpen(strategy.id)}>OPEN</button>
                  {strategy.runningVersion ? (
                    <button type="button" onClick={() => onPaperAction(strategy, active ? "pause" : "start")}>{active ? <Pause size={12} /> : <Play size={12} />}{active ? "PAUSE" : "START"}</button>
                  ) : null}
                  <button type="button" onClick={() => onBacktest(strategy)}><FlaskConical size={12} /> BACKTEST</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

function statusLabel(strategy: StrategySummary) {
  if (!strategy.publishedVersion) return "DRAFT";
  if (strategy.status === "PAPER_ACTIVE") return "PAPER RUNNING";
  if (strategy.status === "PAPER_PAUSED") return "PAPER PAUSED";
  if (strategy.status === "ERROR") return "ERROR";
  if (strategy.status === "DEGRADED") return "RUNTIME RECOVERING";
  return "PAPER READY";
}

function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function signedMoney(value: number) { return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function humanState(value: string) { return value.replaceAll("_", " "); }
function titleCase(value: string) { return `${value.slice(0, 1)}${value.slice(1).toLowerCase()}`; }
function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
