import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Activity, AlertTriangle, BarChart3, BookOpen, Database, FlaskConical, Gauge, RefreshCw, ShieldCheck, TrendingDown, TrendingUp, X } from "lucide-react";
import { eventAlphaApi, type CryptoDriftCandidate, type EventAlphaAudit, type EventAlphaEvent, type EventAlphaHealth, type EventAlphaRuntimeConfig, type EventAlphaThesis, type PeadDetail, type PeadSignal } from "./eventAlphaApi";
import "./event-alpha.css";

type Engine = "CRYPTO" | "PEAD";
type Tab = "RANKED SIGNALS" | "EVIDENCE ARCHIVE" | "METHODOLOGY" | "HEALTH" | "AUDIT" | "CONTROLS";
type Props = { onClose: () => void };
const CRYPTO_FAMILIES = ["ALL", "TOKEN_SUPPLY", "GOVERNANCE", "PROTOCOL_ECONOMICS"] as const;
const PEAD_STATES = ["ALL", "POSITIVE_DRIFT", "NEGATIVE_DRIFT", "FULLY_PRICED", "OVERREACTION", "NO_TRADE"] as const;

export function EventAlphaWorkspace({ onClose }: Props) { return <EventAlphaErrorBoundary onClose={onClose}><EventAlphaWorkspaceContent onClose={onClose} /></EventAlphaErrorBoundary>; }

function EventAlphaWorkspaceContent({ onClose }: Props) {
  const [engine, setEngine] = useState<Engine>("CRYPTO");
  const [tab, setTab] = useState<Tab>("RANKED SIGNALS");
  const [config, setConfig] = useState<EventAlphaRuntimeConfig | null>(null);
  const [events, setEvents] = useState<EventAlphaEvent[]>([]);
  const [theses, setTheses] = useState<EventAlphaThesis[]>([]);
  const [cryptoCandidates, setCryptoCandidates] = useState<CryptoDriftCandidate[]>([]);
  const [peadSignals, setPeadSignals] = useState<PeadSignal[]>([]);
  const [health, setHealth] = useState<EventAlphaHealth | null>(null);
  const [audit, setAudit] = useState<EventAlphaAudit[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventDetail, setEventDetail] = useState<Record<string, unknown> | null>(null);
  const [selectedPeadId, setSelectedPeadId] = useState<string | null>(null);
  const [peadDetail, setPeadDetail] = useState<PeadDetail | null>(null);
  const [cryptoFamily, setCryptoFamily] = useState<(typeof CRYPTO_FAMILIES)[number]>("ALL");
  const [cryptoSymbol, setCryptoSymbol] = useState("");
  const [minimumConfidence, setMinimumConfidence] = useState(0.55);
  const [peadState, setPeadState] = useState<(typeof PEAD_STATES)[number]>("ALL");
  const [peadTicker, setPeadTicker] = useState("");
  const [message, setMessage] = useState("Synchronizing point-in-time evidence…");
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const requestGeneration = ++generation.current;
    setRefreshing(true);
    const results = await Promise.allSettled([
      eventAlphaApi.config(controller.signal), eventAlphaApi.feed(controller.signal), eventAlphaApi.theses(controller.signal),
      eventAlphaApi.rankedCrypto({}, controller.signal), eventAlphaApi.peadSignals({}, controller.signal), eventAlphaApi.health(controller.signal), eventAlphaApi.audit(controller.signal)
    ]);
    if (requestGeneration !== generation.current || controller.signal.aborted) return;
    const [configResult, feedResult, thesisResult, rankedResult, peadResult, healthResult, auditResult] = results;
    if (configResult.status === "fulfilled") setConfig(configResult.value.config);
    if (feedResult.status === "fulfilled") setEvents(array(feedResult.value.events));
    if (thesisResult.status === "fulfilled") setTheses(array(thesisResult.value.theses));
    if (rankedResult.status === "fulfilled") setCryptoCandidates(array(rankedResult.value.candidates));
    if (peadResult.status === "fulfilled") setPeadSignals(array(peadResult.value.signals));
    if (healthResult.status === "fulfilled") setHealth({ ...healthResult.value, sources: array(healthResult.value.sources), peadProviders: array(healthResult.value.peadProviders), pendingJobs: Number(healthResult.value.pendingJobs || 0) });
    if (auditResult.status === "fulfilled") setAudit(array(auditResult.value.records));
    const failures = results.filter((row) => row.status === "rejected");
    const authority = configResult.status === "fulfilled" && configResult.value.config.architecture === "LOCAL_AUTHORITY" ? "encrypted local" : "server-authoritative";
    setMessage(failures.length ? `${results.length - failures.length}/${results.length} evidence surfaces synchronized · ${failures.length} unavailable` : `All ${authority} evidence surfaces synchronized.`);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
    let timer: number | null = null;
    const schedule = () => { if (timer !== null) window.clearInterval(timer); timer = document.hidden ? null : window.setInterval(() => void refresh(), 30_000); };
    const visibility = () => { schedule(); if (!document.hidden) void refresh(); };
    schedule(); document.addEventListener("visibilitychange", visibility);
    return () => { requestAbort.current?.abort(); if (timer !== null) window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [refresh]);

  useEffect(() => {
    if (!selectedEventId) { setEventDetail(null); return; }
    const controller = new AbortController();
    eventAlphaApi.eventDetail(selectedEventId, controller.signal).then(setEventDetail).catch(() => { if (!controller.signal.aborted) setEventDetail(null); });
    return () => controller.abort();
  }, [selectedEventId]);
  useEffect(() => {
    if (!selectedPeadId) { setPeadDetail(null); return; }
    const controller = new AbortController();
    eventAlphaApi.peadDetail(selectedPeadId, controller.signal).then(setPeadDetail).catch(() => { if (!controller.signal.aborted) setPeadDetail(null); });
    return () => controller.abort();
  }, [selectedPeadId]);

  const filteredCrypto = useMemo(() => cryptoCandidates.filter((row) => (cryptoFamily === "ALL" || row.event.event_family === cryptoFamily) && (!cryptoSymbol || row.event.symbol.includes(cryptoSymbol.replace(/[^a-z0-9]/gi, "").toUpperCase())) && Number(row.confidence) >= minimumConfidence), [cryptoCandidates, cryptoFamily, cryptoSymbol, minimumConfidence]);
  const filteredPead = useMemo(() => peadSignals.filter((row) => (peadState === "ALL" || row.signal_state === peadState) && (!peadTicker || row.event.ticker.includes(peadTicker.replace(/[^a-z0-9.-]/gi, "").toUpperCase()))), [peadSignals, peadState, peadTicker]);
  const archiveEvents = useMemo(() => {
    const seen = new Set<string>();
    return events.filter((row) => {
      if (row.event_family !== "PROTOCOL_ECONOMICS") return true;
      const bucket = `${row.symbol}:${row.status}:${row.first_actionable_at.slice(0, 10)}`;
      if (seen.has(bucket)) return false;
      seen.add(bucket);
      return true;
    });
  }, [events]);
  const metrics = useMemo(() => ({
    evidence: engine === "CRYPTO" ? events.length : peadSignals.length,
    directional: engine === "CRYPTO" ? filteredCrypto.filter((row) => row.direction !== "NEUTRAL").length : filteredPead.filter((row) => ["POSITIVE_DRIFT", "NEGATIVE_DRIFT"].includes(row.signal_state)).length,
    noTrade: engine === "CRYPTO" ? theses.filter((row) => row.direction === "NEUTRAL").length : peadSignals.filter((row) => row.signal_state === "NO_TRADE").length,
    degraded: [...array(health?.sources), ...array(health?.peadProviders)].filter((row) => !["HEALTHY", "DISABLED"].includes(String(row.health_status))).length
  }), [engine, events.length, filteredCrypto, filteredPead, health, peadSignals, theses]);
  const setActiveEngine = (next: Engine) => { setEngine(next); setTab("RANKED SIGNALS"); };
  const tabs: Tab[] = ["RANKED SIGNALS", "EVIDENCE ARCHIVE", "METHODOLOGY", "HEALTH", "AUDIT", "CONTROLS"];

  return <section className="event-alpha-workspace" aria-label="Event Alpha workspace">
    <header className="event-alpha-header"><div><b>EVENT ALPHA</b><span>Point-in-time event intelligence · causal expectations · abnormal-return drift</span></div><div className="event-alpha-header-actions"><span className={config?.engineEnabled ? "event-alpha-state live" : "event-alpha-state"}>{config?.engineEnabled ? "ENGINE ACTIVE" : "ENGINE OFF"}</span><button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh Event Alpha"><RefreshCw size={14} className={refreshing ? "spin" : ""} /></button><button type="button" onClick={onClose} aria-label="Close Event Alpha"><X size={16} /></button></div></header>
    <div className="event-alpha-engine-switch"><button type="button" className={engine === "CRYPTO" ? "active" : ""} onClick={() => setActiveEngine("CRYPTO")}><Activity size={14} /><span>CRYPTO EVENT DRIFT<small>Supply · governance · protocol economics</small></span></button><button type="button" className={engine === "PEAD" ? "active" : ""} onClick={() => setActiveEngine("PEAD")}><BarChart3 size={14} /><span>EQUITY PEAD<small>Post-earnings abnormal-return drift</small></span></button></div>
    <div className="event-alpha-safety"><ShieldCheck size={14} /><b>POINT-IN-TIME AUTHORITY</b><span>Lookahead: BLOCKED</span><span>Incomplete evidence: NO_TRADE</span><span>Execution authority: NONE</span></div>
    <div className="event-alpha-metrics"><Metric label={engine === "CRYPTO" ? "CANONICAL EVENTS" : "ASSESSED EARNINGS"} value={metrics.evidence} icon={Database} /><Metric label="DIRECTIONAL CANDIDATES" value={metrics.directional} icon={Activity} /><Metric label="NO TRADE" value={metrics.noTrade} icon={FlaskConical} /><Metric label="DEGRADED SOURCES" value={metrics.degraded} icon={Gauge} warning={metrics.degraded > 0} /></div>
    <nav className="event-alpha-tabs">{tabs.map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</nav>
    <div className="event-alpha-message">{message}</div>
    <div className="event-alpha-body">
      {tab === "RANKED SIGNALS" && engine === "CRYPTO" && <CryptoRanked rows={filteredCrypto} family={cryptoFamily} setFamily={setCryptoFamily} symbol={cryptoSymbol} setSymbol={setCryptoSymbol} minimumConfidence={minimumConfidence} setMinimumConfidence={setMinimumConfidence} onInspect={(id) => { setSelectedEventId(id); setTab("EVIDENCE ARCHIVE"); }} />}
      {tab === "RANKED SIGNALS" && engine === "PEAD" && <PeadWorkspace rows={filteredPead} state={peadState} setState={setPeadState} ticker={peadTicker} setTicker={setPeadTicker} selectedId={selectedPeadId} setSelectedId={setSelectedPeadId} detail={peadDetail} providerConfigured={Boolean(config?.peadProviderConfigured)} />}
      {tab === "EVIDENCE ARCHIVE" && engine === "CRYPTO" && <EventFeed rows={archiveEvents} selectedId={selectedEventId} onSelect={setSelectedEventId} detail={eventDetail} />}
      {tab === "EVIDENCE ARCHIVE" && engine === "PEAD" && <PeadEvidenceArchive rows={peadSignals} onSelect={setSelectedPeadId} />}
      {tab === "METHODOLOGY" && <MethodologyPanel engine={engine} />}{tab === "HEALTH" && <HealthPanel health={health} />}{tab === "AUDIT" && <AuditTable rows={audit} />}{tab === "CONTROLS" && <ControlsPanel config={config} />}
    </div>
  </section>;
}

function Metric({ label, value, icon: Icon, warning = false }: { label: string; value: number; icon: typeof Activity; warning?: boolean }) { return <div className={warning ? "event-alpha-metric warning" : "event-alpha-metric"}><Icon size={15} /><span>{label}</span><b>{value}</b></div>; }
function FilterBar({ children }: { children: ReactNode }) { return <div className="event-alpha-filterbar">{children}</div>; }

function CryptoRanked({ rows, family, setFamily, symbol, setSymbol, minimumConfidence, setMinimumConfidence, onInspect }: { rows: CryptoDriftCandidate[]; family: string; setFamily: (value: (typeof CRYPTO_FAMILIES)[number]) => void; symbol: string; setSymbol: (value: string) => void; minimumConfidence: number; setMinimumConfidence: (value: number) => void; onInspect: (id: string) => void }) {
  return <div className="event-alpha-ranked"><FilterBar><label>FAMILY<select value={family} onChange={(event) => setFamily(event.target.value as (typeof CRYPTO_FAMILIES)[number])}>{CRYPTO_FAMILIES.map((value) => <option key={value}>{value}</option>)}</select></label><label>SYMBOL<input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="BTCUSDT" /></label><label>MIN CONFIDENCE <b>{Math.round(minimumConfidence * 100)}%</b><input type="range" min="0" max="0.95" step="0.05" value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))} /></label><span className="event-alpha-rank-note">Only assessed, market-verified theses are ranked. Raw provider events stay in Evidence Archive.</span></FilterBar><div className="event-alpha-table-shell"><table><thead><tr><th>RANK</th><th>SYMBOL</th><th>EVENT</th><th>DIRECTION</th><th>STATE</th><th>CONFIDENCE</th><th>REMAINING α</th><th>EVENT TIME</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id} role="button" tabIndex={0} onClick={() => onInspect(row.event.id)} onKeyDown={(event) => { if (event.key === "Enter") onInspect(row.event.id); }}><td><b>{index + 1}</b><small>{Number(row.rank_score).toFixed(1)}</small></td><td>{row.event.symbol}<small>MARKET VERIFIED</small></td><td>{row.event.safe_summary}{row.collapsed_event_count > 1 && <small>{row.collapsed_event_count} RELATED EVENTS COLLAPSED</small>}</td><td className={directionClass(row.direction)}>{row.direction}</td><td>{row.state}</td><td>{formatPercent(row.confidence)}</td><td className={directionClass(row.direction)}>{Number(row.remaining_alpha_bps).toFixed(1)} bps</td><td>{formatUtc(row.event.event_time)}</td></tr>)}{!rows.length && <tr><td colSpan={8} className="event-alpha-empty">No market-verified candidate passes the active filters. Evidence was not converted into a synthetic signal.</td></tr>}</tbody></table></div></div>;
}

function PeadWorkspace({ rows, state, setState, ticker, setTicker, selectedId, setSelectedId, detail, providerConfigured }: { rows: PeadSignal[]; state: string; setState: (value: (typeof PEAD_STATES)[number]) => void; ticker: string; setTicker: (value: string) => void; selectedId: string | null; setSelectedId: (value: string) => void; detail: PeadDetail | null; providerConfigured: boolean }) {
  const selected = rows.find((row) => row.id === selectedId) || rows[0] || null;
  useEffect(() => { if (!selectedId && rows[0]) setSelectedId(rows[0].id); }, [rows, selectedId, setSelectedId]);
  return <div className="event-alpha-pead"><FilterBar><label>STATE<select value={state} onChange={(event) => setState(event.target.value as (typeof PEAD_STATES)[number])}>{PEAD_STATES.map((value) => <option key={value}>{value}</option>)}</select></label><label>TICKER<input value={ticker} onChange={(event) => setTicker(event.target.value)} placeholder="COIN" /></label><span className={providerConfigured ? "event-alpha-provider ready" : "event-alpha-provider"}>{providerConfigured ? "NORMALIZED PROVIDER READY" : "AWAITING CONSENSUS + MARKET PROVIDER"}</span></FilterBar><div className="event-alpha-pead-grid"><div className="event-alpha-signal-list">{rows.map((row, index) => <button key={row.id} type="button" className={selected?.id === row.id ? "selected" : ""} onClick={() => setSelectedId(row.id)}><span className={`signal-icon ${directionClass(row.direction)}`}>{row.direction === "LONG" ? <TrendingUp size={14} /> : row.direction === "SHORT" ? <TrendingDown size={14} /> : <Activity size={14} />}</span><b>{index + 1}. {row.event.ticker}</b><strong className={directionClass(row.direction)}>{row.signal_state.replaceAll("_", " ")}</strong><small>{row.event.fiscal_period} · {formatUtc(row.event.announced_at)}</small><em>{formatSigned(row.remaining_drift_bps)} bps remaining · {formatPercent(row.confidence)}</em></button>)}{!rows.length && <div className="event-alpha-empty-card"><FlaskConical size={22} /><b>NO CERTIFIED EQUITY PEAD SIGNALS</b><p>The engine requires a pre-announcement consensus snapshot, verified actuals and a factor-adjusted price path. Missing evidence remains NO_TRADE.</p></div>}</div><PeadAnalysis signal={selected} detail={detail?.signal.id === selected?.id ? detail : null} /></div></div>;
}

function PeadAnalysis({ signal, detail }: { signal: PeadSignal | null; detail: PeadDetail | null }) { if (!signal) return <section className="event-alpha-pead-analysis"><div className="event-alpha-empty-card"><BarChart3 size={24} /><b>SELECT A CERTIFIED EARNINGS EVENT</b><p>No chart is fabricated when point-in-time provider evidence is absent.</p></div></section>; return <section className="event-alpha-pead-analysis"><div className="event-alpha-pead-title"><div><small>{signal.event.issuer} · {signal.event.fiscal_period}</small><h2>{signal.event.ticker} <span className={directionClass(signal.direction)}>{signal.signal_state.replaceAll("_", " ")}</span></h2></div><b>{formatPercent(signal.confidence)} CONFIDENCE</b></div><div className="event-alpha-pead-kpis"><Kpi label="EPS SUE" value={formatSigned(signal.eps_sue)} /><Kpi label="REVENUE SUE" value={formatSigned(signal.revenue_sue)} /><Kpi label="ANNOUNCEMENT CAR" value={`${formatSigned(signal.total_car_bps)} bps`} /><Kpi label="EXPECTED DRIFT" value={`${formatSigned(signal.expected_drift_bps)} bps`} /><Kpi label="REMAINING" value={`${formatSigned(signal.remaining_drift_bps)} bps`} tone={directionClass(signal.direction)} /></div><PeadChart detail={detail} expected={Number(signal.expected_drift_bps)} /><div className="event-alpha-pead-reasons"><b>CLASSIFICATION EVIDENCE</b>{signal.reason_codes.map((reason) => <span key={reason}>{reason.replaceAll("_", " ")}</span>)}</div><div className="event-alpha-causality-strip"><span>CONSENSUS LOCKED {formatUtc(signal.event.expectation_as_of)}</span><span>ANNOUNCED {formatUtc(signal.event.announced_at)}</span><span>{signal.methodology_version}</span></div></section>; }
function Kpi({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div><span>{label}</span><b className={tone}>{value}</b></div>; }

function PeadChart({ detail, expected }: { detail: PeadDetail | null; expected: number }) {
  const [hover, setHover] = useState<number | null>(null); const points = detail?.returnPath || [];
  if (!points.length) return <div className="event-alpha-pead-chart empty"><span>LOADING IMMUTABLE ABNORMAL-RETURN PATH…</span></div>;
  const width = 720, height = 250, pad = 28; const values = points.map((row) => Number(row.cumulative_abnormal_return_bps)); const bound = Math.max(25, Math.abs(expected), ...values.map(Math.abs)) * 1.15;
  const x = (index: number) => pad + index / Math.max(1, points.length - 1) * (width - pad * 2); const y = (value: number) => height / 2 - value / bound * (height / 2 - pad); const path = points.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(Number(row.cumulative_abnormal_return_bps)).toFixed(1)}`).join(" "); const active = hover === null ? null : points[hover];
  return <div className="event-alpha-pead-chart" onMouseLeave={() => setHover(null)}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative abnormal return after earnings"><defs><linearGradient id="pead-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f4f5f7" stopOpacity=".28" /><stop offset="1" stopColor="#90001a" stopOpacity=".04" /></linearGradient></defs><line x1={pad} y1={height / 2} x2={width - pad} y2={height / 2} className="zero" /><line x1={pad} y1={y(expected)} x2={width - pad} y2={y(expected)} className="expected" /><path d={`${path} L${x(points.length - 1)},${height / 2} L${x(0)},${height / 2} Z`} className="area" /><path d={path} className="car" />{points.map((row, index) => <circle key={row.observed_at} cx={x(index)} cy={y(Number(row.cumulative_abnormal_return_bps))} r={hover === index ? 4 : 2} onMouseEnter={() => setHover(index)} />)}</svg><div className="event-alpha-chart-label expected">EXPECTED {formatSigned(expected)} BPS</div>{active && <div className="event-alpha-chart-tooltip"><b>{formatUtc(active.observed_at)}</b><span>CAR {formatSigned(active.cumulative_abnormal_return_bps)} bps</span><span>ABNORMAL {formatSigned(active.abnormal_return_bps)} bps</span><span>PRICE {active.price === null ? "—" : formatNumber(active.price)}</span></div>}</div>;
}

function EventFeed({ rows, selectedId, onSelect, detail }: { rows: EventAlphaEvent[]; selectedId: string | null; onSelect: (id: string) => void; detail: Record<string, unknown> | null }) { return <div className="event-alpha-split"><div className="event-alpha-table-shell"><table><thead><tr><th>KNOWN</th><th>FAMILY</th><th>ASSET</th><th>RAW EVIDENCE</th><th>CONF.</th><th>REV.</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className={selectedId === row.id ? "selected" : ""} role="button" tabIndex={0} onClick={() => onSelect(row.id)} onKeyDown={(event) => { if (event.key === "Enter") onSelect(row.id); }}><td>{formatUtc(row.first_actionable_at)}</td><td>{row.event_family}</td><td>{row.symbol}</td><td>{row.safe_summary}</td><td>{formatPercent(row.source_confidence)}</td><td>{row.current_revision}</td></tr>)}{!rows.length && <tr><td colSpan={6} className="event-alpha-empty">No canonical event evidence has been published.</td></tr>}</tbody></table></div><aside className="event-alpha-detail"><h3>IMMUTABLE EVENT EVIDENCE</h3>{detail ? <pre>{JSON.stringify(detail, null, 2)}</pre> : <p>This archive includes unassessed and untradable source events. Select a revision to inspect its causal evidence chain.</p>}</aside></div>; }
function PeadEvidenceArchive({ rows, onSelect }: { rows: PeadSignal[]; onSelect: (id: string) => void }) { return <div className="event-alpha-table-shell"><table><thead><tr><th>ANNOUNCED</th><th>TICKER</th><th>ISSUER</th><th>PERIOD</th><th>CONSENSUS AS-OF</th><th>REV.</th><th>METHODOLOGY</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} role="button" tabIndex={0} onClick={() => onSelect(row.id)}><td>{formatUtc(row.event.announced_at)}</td><td>{row.event.ticker}</td><td>{row.event.issuer}</td><td>{row.event.fiscal_period}</td><td>{formatUtc(row.event.expectation_as_of)}</td><td>{row.event.current_revision}</td><td>{row.methodology_version}</td></tr>)}{!rows.length && <tr><td colSpan={7} className="event-alpha-empty">No immutable PEAD assessment has been ingested.</td></tr>}</tbody></table></div>; }

function MethodologyPanel({ engine }: { engine: Engine }) { return <div className="event-alpha-cards">{engine === "CRYPTO" ? <><article><BookOpen size={18} /><h3>CRYPTO EVENT DRIFT</h3><p>Supply, governance and protocol-economics evidence is normalized independently. Only events with causal expectations and verified market evidence become ranked theses.</p></article><article><Activity size={18} /><h3>REMAINING ALPHA</h3><p>Signed economic impact minus benchmark-adjusted realized response, uncertainty and transaction costs. A large feed count is not a signal.</p></article><article><ShieldCheck size={18} /><h3>NO PEAD LABEL</h3><p>Tokens do not publish issuer earnings. Crypto events remain a separate event-drift engine and BTC is used as a benchmark where appropriate.</p></article></> : <><article><BookOpen size={18} /><h3>STANDARDIZED SURPRISE</h3><p>EPS and revenue errors are divided by robust historical forecast-error dispersion. Guidance and margin surprises contribute only when verified point-in-time evidence exists.</p></article><article><BarChart3 size={18} /><h3>ABNORMAL RETURN</h3><p>AR = stock return − β×market return − sector β×sector return. CAR is the cumulative abnormal return after the first actionable earnings timestamp.</p></article><article><ShieldCheck size={18} /><h3>REMAINING DRIFT</h3><p>Expected drift from standardized surprise minus observed CAR and costs. Fully priced, overreacted, weak or incomplete cases are explicitly classified without a trade.</p></article></>}</div>; }
function HealthPanel({ health }: { health: EventAlphaHealth | null }) { const sources = [...array(health?.sources).map((row) => ({ key: row.source_key, ...row })), ...array(health?.peadProviders).map((row) => ({ key: row.provider_key, ...row }))]; return <div className="event-alpha-health-grid"><article><h3>WORK QUEUE</h3><b>{health?.pendingJobs ?? "—"}</b><p>Queued or leased durable jobs</p></article>{sources.map((source) => <article key={source.key} className={source.health_status === "HEALTHY" ? "healthy" : "degraded"}><h3>{source.key}</h3><b>{source.health_status}</b><p>{source.safe_error_code || `Last success ${formatUtc(source.last_success_at)}`}</p></article>)}{!sources.length && <article><h3>LIVE SOURCES</h3><b>NOT REGISTERED</b><p>No provider has registered with the server worker.</p></article>}</div>; }
function AuditTable({ rows }: { rows: EventAlphaAudit[] }) { return <div className="event-alpha-table-shell"><table><thead><tr><th>TIME</th><th>DECISION</th><th>OUTCOME</th><th>ACTOR</th><th>REASONS</th><th>EVIDENCE</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{formatUtc(row.created_at)}</td><td>{row.decision_type}</td><td>{row.outcome}</td><td>{row.actor_type}</td><td>{row.reason_codes?.join(" · ") || "—"}</td><td title={row.evidence_hash}>{row.evidence_hash.slice(0, 12)}…</td></tr>)}{!rows.length && <tr><td colSpan={6} className="event-alpha-empty">No immutable decision audit exists.</td></tr>}</tbody></table></div>; }
function ControlsPanel({ config }: { config: EventAlphaRuntimeConfig | null }) { const local = config?.architecture === "LOCAL_AUTHORITY"; const controls = [["Engine rollout", config?.engineEnabled, local ? "encrypted local authority" : "EVENT_ALPHA_ENGINE_ENABLED"], ["Crypto ingestion", config?.ingestionEnabled, local ? "local provider required" : "server worker"], ["Equity PEAD engine", config?.equityPeadEnabled, local ? "local provider required" : "EVENT_ALPHA_EQUITY_PEAD_ENABLED"], ["PEAD normalized provider", config?.peadProviderConfigured, "consensus + actuals + factor returns"], ["Paper execution", config?.paperExecutionEnabled, "separate approval boundary"], ["Manual approval", config?.manualApprovalRequired, "always required"]] as const; return <div className="event-alpha-controls"><div className="event-alpha-warning"><AlertTriangle size={17} /><div><b>FAIL-CLOSED RESEARCH CONTROL PLANE</b><p>Data controls are {local ? "local provider and encrypted evidence policy" : "server environment policy"}. A missing consensus, filing, market path or causal timestamp produces NO_TRADE.</p></div></div>{controls.map(([label, enabled, note]) => <div key={label}><span>{label}</span><b className={enabled ? "on" : "off"}>{enabled ? "ENABLED" : "DISABLED"}</b><small>{note}</small></div>)}</div>; }

class EventAlphaErrorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> { state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; } componentDidCatch(error: Error, info: ErrorInfo) { console.error("[event-alpha-ui-boundary]", { name: error.name, componentStack: info.componentStack }); } render() { if (!this.state.failed) return this.props.children; return <section className="event-alpha-workspace event-alpha-recovery"><div><AlertTriangle size={22} /><b>EVENT ALPHA DISPLAY RECOVERED</b><p>The client projection failed. Authoritative evidence was not changed.</p><button type="button" onClick={() => this.setState({ failed: false })}>RETRY WORKSPACE</button><button type="button" onClick={this.props.onClose}>RETURN TO CHART</button></div></section>; } }
function array<T>(value: T[] | null | undefined): T[] { return Array.isArray(value) ? value : []; }
function directionClass(value: string) { return value === "LONG" ? "long" : value === "SHORT" ? "short" : "neutral"; }
function formatUtc(value?: string | null) { if (!value) return "—"; const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString().replace("T", " ").slice(0, 19) + "Z" : "INVALID"; }
function formatPercent(value: number) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "—"; }
function formatSigned(value: number | string) { const number = Number(value); return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}` : "—"; }
function formatNumber(value: number) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value); }
