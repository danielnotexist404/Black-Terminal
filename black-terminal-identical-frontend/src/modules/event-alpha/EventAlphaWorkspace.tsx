import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Activity, AlertTriangle, BookOpen, Database, FlaskConical, Gauge, RefreshCw, ShieldCheck, X } from "lucide-react";
import { eventAlphaApi, type EventAlphaAudit, type EventAlphaEvent, type EventAlphaHealth, type EventAlphaRuntimeConfig, type EventAlphaThesis } from "./eventAlphaApi";
import "./event-alpha.css";

type Tab = "EVENT FEED" | "THESES" | "RESEARCH" | "HEALTH" | "AUDIT" | "CONTROLS";

type Props = { onClose: () => void };

export function EventAlphaWorkspace({ onClose }: Props) {
  return <EventAlphaErrorBoundary onClose={onClose}><EventAlphaWorkspaceContent onClose={onClose} /></EventAlphaErrorBoundary>;
}

function EventAlphaWorkspaceContent({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("EVENT FEED");
  const [config, setConfig] = useState<EventAlphaRuntimeConfig | null>(null);
  const [events, setEvents] = useState<EventAlphaEvent[]>([]);
  const [theses, setTheses] = useState<EventAlphaThesis[]>([]);
  const [health, setHealth] = useState<EventAlphaHealth | null>(null);
  const [audit, setAudit] = useState<EventAlphaAudit[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("Loading Event Alpha control plane…");
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const signal = controller.signal;
    const requestGeneration = ++generation.current;
    setRefreshing(true);
    try {
      const [configResult, feedResult, thesisResult, healthResult, auditResult] = await Promise.all([
        eventAlphaApi.config(signal), eventAlphaApi.feed(signal), eventAlphaApi.theses(signal), eventAlphaApi.health(signal), eventAlphaApi.audit(signal)
      ]);
      if (requestGeneration !== generation.current || signal?.aborted) return;
      setConfig(configResult.config);
      setEvents(Array.isArray(feedResult?.events) ? feedResult.events : []);
      setTheses(Array.isArray(thesisResult?.theses) ? thesisResult.theses : []);
      setHealth({ ...healthResult, sources: Array.isArray(healthResult?.sources) ? healthResult.sources : [], pendingJobs: Number(healthResult?.pendingJobs || 0) });
      setAudit(Array.isArray(auditResult?.records) ? auditResult.records : []);
      setMessage(configResult.config.engineEnabled ? "Server evidence synchronized." : "Engine rollout is disabled. Historical evidence remains readable.");
    } catch (error) {
      if (!signal?.aborted && requestGeneration === generation.current) setMessage(error instanceof Error ? error.message : "Event Alpha synchronization failed.");
    } finally {
      if (requestGeneration === generation.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = document.hidden ? null : window.setInterval(() => void refresh(), 30_000);
    };
    const visibility = () => { schedule(); if (!document.hidden) void refresh(); };
    schedule();
    document.addEventListener("visibilitychange", visibility);
    return () => { requestAbort.current?.abort(); if (timer !== null) window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [refresh]);

  useEffect(() => {
    if (!selectedEventId) { setDetail(null); return; }
    const controller = new AbortController();
    eventAlphaApi.eventDetail(selectedEventId, controller.signal).then(setDetail).catch((error) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Event detail failed.");
    });
    return () => controller.abort();
  }, [selectedEventId]);

  const metrics = useMemo(() => ({
    events: events.length,
    activeTheses: theses.filter((row) => ["OBSERVING", "ARMED", "TRIGGERED", "PAPER_ACTIVE"].includes(row.state)).length,
    paperActive: theses.filter((row) => row.state === "PAPER_ACTIVE").length,
    unhealthySources: (Array.isArray(health?.sources) ? health.sources : []).filter((row) => !["HEALTHY", "DISABLED"].includes(row.health_status)).length
  }), [events, health, theses]);

  return (
    <section className="event-alpha-workspace" aria-label="Event Alpha workspace">
      <header className="event-alpha-header">
        <div><b>EVENT ALPHA ENGINE</b><span>Live point-in-time event intelligence · server-authoritative evidence · paper-only execution</span></div>
        <div className="event-alpha-header-actions">
          <span className={config?.engineEnabled ? "event-alpha-state live" : "event-alpha-state"}>{config?.engineEnabled ? "ENGINE ACTIVE" : "ENGINE OFF"}</span>
          <button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh Event Alpha"><RefreshCw size={14} className={refreshing ? "spin" : ""} /></button>
          <button type="button" onClick={onClose} aria-label="Close Event Alpha"><X size={16} /></button>
        </div>
      </header>
      <div className="event-alpha-safety">
        <ShieldCheck size={14} /> <b>SERVER AUTHORITY</b>
        <span>Live execution: FORBIDDEN</span><span>LLM order authority: NONE</span><span>Direct browser fan-out: NONE</span>
      </div>
      <div className="event-alpha-metrics">
        <Metric label="CANONICAL EVENTS" value={metrics.events} icon={Database} />
        <Metric label="ACTIVE THESES" value={metrics.activeTheses} icon={Activity} />
        <Metric label="PAPER ACTIVE" value={metrics.paperActive} icon={FlaskConical} />
        <Metric label="DEGRADED SOURCES" value={metrics.unhealthySources} icon={Gauge} warning={metrics.unhealthySources > 0} />
      </div>
      <nav className="event-alpha-tabs">
        {(["EVENT FEED", "THESES", "RESEARCH", "HEALTH", "AUDIT", "CONTROLS"] as Tab[]).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
      </nav>
      <div className="event-alpha-message">{message}</div>
      <div className="event-alpha-body">
        {tab === "EVENT FEED" && <EventFeed rows={events} selectedId={selectedEventId} onSelect={setSelectedEventId} detail={detail} />}
        {tab === "THESES" && <ThesisTable rows={theses} />}
        {tab === "RESEARCH" && <ResearchPanel />}
        {tab === "HEALTH" && <HealthPanel health={health} />}
        {tab === "AUDIT" && <AuditTable rows={audit} />}
        {tab === "CONTROLS" && <ControlsPanel config={config} />}
      </div>
    </section>
  );
}

function Metric({ label, value, icon: Icon, warning = false }: { label: string; value: number; icon: typeof Activity; warning?: boolean }) {
  return <div className={warning ? "event-alpha-metric warning" : "event-alpha-metric"}><Icon size={15} /><span>{label}</span><b>{value}</b></div>;
}

function EventFeed({ rows, selectedId, onSelect, detail }: { rows: EventAlphaEvent[]; selectedId: string | null; onSelect: (id: string) => void; detail: Record<string, unknown> | null }) {
  return <div className="event-alpha-split">
    <div className="event-alpha-table-shell"><table><thead><tr><th>TIME</th><th>FAMILY</th><th>ASSET</th><th>EVENT</th><th>CONF.</th><th>REV.</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id} className={selectedId === row.id ? "selected" : ""} role="button" tabIndex={0} aria-selected={selectedId === row.id} onClick={() => onSelect(row.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(row.id); }}><td>{formatUtc(row.first_actionable_at)}</td><td>{row.event_family}</td><td>{row.symbol}</td><td>{row.safe_summary}</td><td>{formatPercent(Number(row.source_confidence))}</td><td>{row.current_revision}</td></tr>)}
      {!rows.length && <tr><td colSpan={6} className="event-alpha-empty">No canonical event evidence has been published.</td></tr>}
    </tbody></table></div>
    <aside className="event-alpha-detail"><h3>EVENT EVIDENCE</h3>{detail ? <pre>{JSON.stringify(detail, null, 2)}</pre> : <p>Select an immutable event revision to inspect expectations and theses.</p>}</aside>
  </div>;
}

function ThesisTable({ rows }: { rows: EventAlphaThesis[] }) {
  return <div className="event-alpha-table-shell"><table><thead><tr><th>UPDATED</th><th>FAMILY</th><th>DIRECTION</th><th>STATE</th><th>CONFIDENCE</th><th>REMAINING α</th><th>REASONS</th><th>EXPIRY</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.id}><td>{formatUtc(row.updated_at)}</td><td>{row.event_family}</td><td className={row.direction === "SHORT" ? "short" : row.direction === "LONG" ? "long" : ""}>{row.direction}</td><td>{row.state}</td><td>{formatPercent(Number(row.confidence))}</td><td>{Number(row.remaining_alpha_bps).toFixed(2)} bps</td><td>{row.reason_codes?.join(" · ") || "—"}</td><td>{formatUtc(row.expires_at)}</td></tr>)}
    {!rows.length && <tr><td colSpan={8} className="event-alpha-empty">No event thesis exists.</td></tr>}
  </tbody></table></div>;
}

function ResearchPanel() {
  return <div className="event-alpha-cards">
    <article><BookOpen size={18} /><h3>EVENT THESIS</h3><p>Event Alpha estimates a point-in-time expectation, scores the surprise, applies asset economics, subtracts abnormal price response and costs, then classifies remaining alpha.</p></article>
    <article><Activity size={18} /><h3>TACTICAL SEPARATION</h3><p>BC-RDA tactical confirmation is blocked during signal-integrity containment. Event Alpha cannot consume legacy or Causal V2 dots until a separately certified runtime is approved.</p></article>
    <article><ShieldCheck size={18} /><h3>CAUSALITY</h3><p>Expectation snapshots must predate first actionable evidence. Revisions are append-only, replay is point-in-time, and absent evidence becomes NO_TRADE—not a synthetic fallback.</p></article>
  </div>;
}

function HealthPanel({ health }: { health: EventAlphaHealth | null }) {
  const sources = Array.isArray(health?.sources) ? health.sources : [];
  return <div className="event-alpha-health-grid">
    <article><h3>WORK QUEUE</h3><b>{health?.pendingJobs ?? "—"}</b><p>Queued or leased durable jobs</p></article>
    {sources.map((source) => <article key={source.source_key} className={source.health_status === "HEALTHY" ? "healthy" : "degraded"}><h3>{source.source_key}</h3><b>{source.health_status}</b><p>{source.safe_error_code || `Last success ${formatUtc(source.last_success_at)}`}</p></article>)}
    {!sources.length && <article><h3>LIVE SOURCES</h3><b>NOT REGISTERED</b><p>The ingestion worker has not registered a source yet.</p></article>}
  </div>;
}

function AuditTable({ rows }: { rows: EventAlphaAudit[] }) {
  return <div className="event-alpha-table-shell"><table><thead><tr><th>TIME</th><th>DECISION</th><th>OUTCOME</th><th>ACTOR</th><th>REASONS</th><th>EVIDENCE</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.id}><td>{formatUtc(row.created_at)}</td><td>{row.decision_type}</td><td>{row.outcome}</td><td>{row.actor_type}</td><td>{row.reason_codes?.join(" · ") || "—"}</td><td title={row.evidence_hash}>{row.evidence_hash.slice(0, 12)}…</td></tr>)}
    {!rows.length && <tr><td colSpan={6} className="event-alpha-empty">No immutable decision audit exists.</td></tr>}
  </tbody></table></div>;
}

function ControlsPanel({ config }: { config: EventAlphaRuntimeConfig | null }) {
  const controls = [
    ["Engine rollout", config?.engineEnabled, "EVENT_ALPHA_ENGINE_ENABLED"],
    ["Ingestion rollout", config?.ingestionEnabled, "EVENT_ALPHA_INGESTION_ENABLED"],
    ["Paper execution", config?.paperExecutionEnabled, "EVENT_ALPHA_PAPER_EXECUTION_ENABLED"],
    ["Manual approval", config?.manualApprovalRequired, "EVENT_ALPHA_REQUIRE_MANUAL_APPROVAL"],
    ["Strategy kill switch clear", config ? !config.strategyKillSwitchEngaged : false, "must be explicitly cleared"],
    ["Global execution kill switch clear", config ? !config.globalExecutionKillSwitchEngaged : false, "must be explicitly cleared"],
    ["Token unlock adapter", config?.tokenUnlockSourceConfigured, "credentialed server source"],
    ["Snapshot governance feed", config?.governanceAdapterEnabled, "public GraphQL · point-in-time vote outcome"],
    ["DefiLlama economics feed", config?.protocolEconomicsAdapterEnabled, "public protocol revenue evidence"]
  ] as const;
  return <div className="event-alpha-controls"><div className="event-alpha-warning"><AlertTriangle size={17} /><div><b>FAIL-CLOSED ROLLOUT</b><p>Controls are server environment policy, not browser toggles. Live Event Alpha execution is structurally unavailable.</p></div></div>{controls.map(([label, enabled, note]) => <div key={label}><span>{label}</span><b className={enabled ? "on" : "off"}>{enabled ? "ENABLED" : "DISABLED"}</b><small>{note}</small></div>)}</div>;
}

class EventAlphaErrorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[event-alpha-ui-boundary]", { name: error.name, componentStack: info.componentStack });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="event-alpha-workspace event-alpha-recovery"><div><AlertTriangle size={22} /><b>EVENT ALPHA DISPLAY RECOVERED</b><p>The workspace encountered an invalid client projection. Server evidence was not changed.</p><button type="button" onClick={() => this.setState({ failed: false })}>RETRY WORKSPACE</button><button type="button" onClick={this.props.onClose}>RETURN TO CHART</button></div></section>;
  }
}

function formatUtc(value?: string | null) { if (!value) return "—"; const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString().replace("T", " ").slice(0, 19) + "Z" : "INVALID"; }
function formatPercent(value: number) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—"; }
