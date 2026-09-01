import { Activity, AlertTriangle, ArrowLeft, Check, Database, LockKeyhole, Pause, Play, Radio, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { defaultQalcDraft, qalcApi, type QalcDraft, type QalcRuntimeStatus, type QalcSavedStrategy } from "./qalcApi";
import { loadQalcStrategyHandoff, qalcDraftFromHandoff } from "../../qalc-indicator/config";
import { isLocalOnlyRuntime } from "../../../core/local-runtime/localRuntimeClient";

const steps = ["Market", "Data Quality", "Feature Model", "Quote Policy", "Inventory Exit", "Risk", "Paper Latency", "Review"];

export function QalcExperience({ onBack }: { onBack: () => void }) {
  const localOnly = isLocalOnlyRuntime();
  const [step, setStep] = useState(0);
  const [handoff] = useState(loadQalcStrategyHandoff);
  const [draft, setDraft] = useState<QalcDraft>(() => defaultQalcDraft(qalcDraftFromHandoff(handoff)));
  const [saved, setSaved] = useState<QalcSavedStrategy>();
  const [status, setStatus] = useState<QalcRuntimeStatus>({ available: false, source: "NO_FALLBACK", certificationState: "RESEARCH", runtimeState: "STOPPED" });
  const [history, setHistory] = useState<Record<string, number[]>>({ imbalance: [], microprice: [], ofi: [], cvd: [], replenishment: [], toxicity: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(handoff ? `Loaded the exact chart configuration ${handoff.configurationHash} from BC-QALC.` : undefined);
  const [cockpit, setCockpit] = useState(false);

  useEffect(() => {
    if (handoff) return;
    const controller = new AbortController();
    void qalcApi.list(controller.signal).then(({ strategies }) => {
      if (controller.signal.aborted || !strategies.length) return;
      const latest = strategies[0];
      setSaved(latest);
      setDraft({ name: latest.name, symbol: latest.symbol, mode: "PAPER", config: structuredClone(latest.config) });
      setMessage(`Restored encrypted BC-QALC configuration V${latest.revision}.`);
      if (latest.desired_state === "ACTIVE") setCockpit(true);
    }).catch((error) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "BC-QALC configurations could not be restored.");
    });
    return () => controller.abort();
  }, [handoff]);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const next = await qalcApi.status(controller.signal);
        if (!controller.signal.aborted) { setStatus(next); setHistory((current) => appendHistory(current, next)); }
      } catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "QALC status unavailable."); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  const save = async () => {
    if (draft.name.trim().length < 3) return setMessage("Name this Paper candidate before saving.");
    setBusy(true);
    try {
      const response = saved ? await qalcApi.update(saved.id, draft) : await qalcApi.create(draft);
      setSaved(response.strategy); setCockpit(true); setMessage(localOnly ? "Private BC-QALC Paper configuration saved in encrypted local storage. Live execution and group fanout remain disabled." : "Private BC-QALC Paper configuration saved on the VPS. Live execution and group fanout remain disabled.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "BC-QALC configuration could not be saved."); }
    finally { setBusy(false); }
  };

  const runtimeAction = async (state: "ACTIVE" | "PAUSED" | "STOPPED") => {
    if (!saved) return;
    setBusy(true);
    try { const response = await qalcApi.state(saved.id, state); setSaved(response.strategy); setMessage(`Paper candidate is ${state.toLowerCase()}.`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "BC-QALC runtime action failed."); }
    finally { setBusy(false); }
  };

  if (cockpit) return <QalcCockpit strategy={saved} status={status} history={history} busy={busy} message={message} onBack={() => setCockpit(false)} onAction={runtimeAction} />;

  return <section className="qalc-experience">
    <header className="qalc-head"><button type="button" onClick={onBack}><ArrowLeft size={14} /> MY STRATEGY</button><div><span>MICROSTRUCTURE / NATIVE EVENT ENGINE</span><h1>BC-QALC — Queue-Aware Liquidity Capture</h1></div><b><LockKeyhole size={12} /> PAPER CERTIFICATION REQUIRED</b></header>
    {message ? <div className="strategy-library-message" role="status">{message}</div> : null}
    <div className="qalc-wizard-layout">
      <nav>{steps.map((label, index) => <button type="button" className={index === step ? "active" : index < step ? "complete" : ""} onClick={() => setStep(index)} key={label}><span>{index < step ? <Check size={12} /> : String(index + 1).padStart(2, "0")}</span><strong>{label}</strong></button>)}</nav>
      <main>
        <WizardStep number={step + 1} title={steps[step]} description={description(step)}>{renderStep(step, draft, setDraft, status)}</WizardStep>
        <footer><button type="button" disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)}>BACK</button><span />{step < 7 ? <button type="button" className="primary" onClick={() => setStep((value) => value + 1)}>CONTINUE</button> : <button type="button" className="primary" disabled={busy} onClick={() => void save()}><Save size={13} /> SAVE PAPER CONFIGURATION</button>}</footer>
      </main>
      <aside><span>BOUNDARY SUMMARY</span><Summary label="VENUE" value="BYBIT" /><Summary label="MARKET" value={`${draft.symbol} / LINEAR`} /><Summary label="ORDER" value="POSTONLY / ONE-SIDED" /><Summary label="QUEUE MODEL" value="CONSERVATIVE" /><Summary label="MODE" value="PAPER CANDIDATE" /><Summary label="LIVE ORDERS" value="DISABLED" tone="locked" /><Summary label="GROUP FANOUT" value="DISABLED" tone="locked" /><Summary label="CERTIFICATION" value={status.certificationState || "RESEARCH"} /></aside>
    </div>
  </section>;
}

function WizardStep({ number, title, description, children }: { number: number; title: string; description: string; children: React.ReactNode }) { return <section className="strategy-wizard-section"><header><span>{String(number).padStart(2, "0")}</span><div><h2>{title}</h2><p>{description}</p></div></header>{children}</section>; }
function Summary({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div><span>{label}</span><strong className={tone}>{value}</strong></div>; }

function renderStep(step: number, draft: QalcDraft, setDraft: React.Dispatch<React.SetStateAction<QalcDraft>>, status: QalcRuntimeStatus) {
  const field = (key: keyof QalcDraft["config"], value: number) => setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));
  if (step === 0) return <div className="strategy-form-grid"><Label title="Strategy name"><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Label><Label title="Venue"><select disabled><option>Bybit</option></select></Label><Label title="Symbol"><select value={draft.symbol} onChange={(event) => setDraft((current) => ({ ...current, symbol: event.target.value as QalcDraft["symbol"] }))}><option>BTCUSDT</option><option disabled>ETHUSDT — staged after BTC baseline</option></select></Label><Label title="Category"><select disabled><option>Linear Futures</option></select></Label><NumberField title="Paper equity" value={draft.config.paperEquity} onChange={(value) => field("paperEquity", value)} /><NumberField title="Strategy allocation %" value={draft.config.strategyAllocationPercent} onChange={(value) => field("strategyAllocationPercent", value)} /></div>;
  if (step === 1) return <div className="qalc-health-grid"><Health icon={<Database size={15} />} label="Canonical book" value={status.book?.state || "NOT CONNECTED"} /><Health icon={<Radio size={15} />} label="Public trades" value={status.available ? "CANONICAL FEED" : "UNAVAILABLE"} /><Health icon={<Activity size={15} />} label="Book age" value={status.book ? `${Math.round(status.book.ageMs)} ms` : "—"} /><Health icon={<ShieldCheck size={15} />} label="Clock" value={status.clock?.state || "UNSAFE"} /><div className="qalc-boundary-note"><AlertTriangle size={15} /><span>Any gap, stale feed, crossed book, clock drift or sequence regression blocks Paper quoting. No unverified browser fallback exists.</span></div></div>;
  if (step === 2) return <div className="strategy-form-grid"><Label title="Model version"><input disabled value="BC-QALC-BASELINE-1" /></Label><Label title="Prediction horizon"><select value={draft.config.predictionHorizonMs} onChange={(event) => field("predictionHorizonMs", Number(event.target.value))}>{[250,500,1000,3000,5000,10000].map((value) => <option value={value} key={value}>{value >= 1000 ? `${value / 1000}s` : `${value}ms`}</option>)}</select></Label><NumberField title="Minimum all-in edge multiple" value={draft.config.minimumNetEdgeMultiplier} step={0.1} onChange={(value) => field("minimumNetEdgeMultiplier", value)} /><NumberField title="Toxicity threshold" value={draft.config.maximumToxicity} onChange={(value) => field("maximumToxicity", value)} /><NumberField title="Minimum P(fill)" value={draft.config.minimumFillProbability} step={0.01} onChange={(value) => field("minimumFillProbability", value)} /></div>;
  if (step === 3) return <div className="strategy-form-grid"><Label title="Quote side"><input disabled value="One-sided automatic" /></Label><Label title="Order type"><input disabled value="PostOnly" /></Label><Label title="Placement"><input disabled value="Queue Optimized" /></Label><NumberField title="Quote lifetime (ms)" value={draft.config.quoteLifetimeMs} onChange={(value) => field("quoteLifetimeMs", value)} /><NumberField title="Max quote actions / second" value={draft.config.maximumQuoteActionsPerSecond} onChange={(value) => field("maximumQuoteActionsPerSecond", value)} /></div>;
  if (step === 4) return <div className="strategy-form-grid"><NumberField title="Maximum inventory time (ms)" value={draft.config.maximumInventoryDurationMs} onChange={(value) => field("maximumInventoryDurationMs", value)} /><Label title="Normal exit"><input disabled value="Time / edge invalidation" /></Label><Label title="Emergency exit"><input disabled value="Toxicity / hard stop" /></Label><Label title="Inventory policy"><input disabled value="Single position · no averaging" /></Label></div>;
  if (step === 5) return <div className="strategy-form-grid"><NumberField title="Risk per trade %" value={draft.config.riskPerTradePercent} step={0.001} onChange={(value) => field("riskPerTradePercent", value)} /><NumberField title="Daily loss %" value={draft.config.maximumDailyLossPercent} step={0.05} onChange={(value) => field("maximumDailyLossPercent", value)} /><NumberField title="Hard stop (ticks)" value={draft.config.hardStopTicks} onChange={(value) => field("hardStopTicks", value)} /><NumberField title="Consecutive loss limit" value={draft.config.maximumConsecutiveLosses} onChange={(value) => field("maximumConsecutiveLosses", value)} /><Label title="Leverage"><input disabled value="1x maximum" /></Label><Label title="Adverse-selection kill switch"><input disabled value="Always enabled" /></Label></div>;
  if (step === 6) return <div className="qalc-latency-stack">{[["Market data",30],["Processing",3],["Submission",35],["Acknowledgement",35],["Cancel",50],["Execution notification",35]].map(([label,value]) => <div key={label}><span>{label}</span><strong>{value} ms</strong><em>Conservative baseline</em></div>)}<p>Zero-latency fills are prohibited. These values are applied in Paper replay and replaced by measured distributions during certification.</p></div>;
  return <div className="qalc-review"><h3>BC-QALC Paper candidate boundary</h3><div>{[["Engine","black-core-qalc"],["Market",`${draft.symbol} / Bybit linear`],["Chart configuration",draft.config.indicatorConfigHash || "Strategy Lab defaults"],["Configuration schema",String(draft.config.indicatorConfigVersion || 1)],["Book","L200 canonical → L50 features"],["Direction / fill / toxicity","Separate interpretable models"],["Cost gate","Fees + exit + slippage + adverse selection + buffer"],["Fill simulation","Observed taker flow after conservative queue-ahead"],["Live order submission","NOT IMPLEMENTED"],["Investment Group fanout","NOT IMPLEMENTED"]].map(([key,value]) => <p key={key}><span>{key}</span><strong>{value}</strong></p>)}</div><div className="qalc-boundary-note"><LockKeyhole size={15} /><span>Saving creates a private research/Paper configuration linked to this exact indicator hash. It does not publish it, connect a broker, or place an order.</span></div></div>;
}

function QalcCockpit({ strategy, status, history, busy, message, onBack, onAction }: { strategy?: QalcSavedStrategy; status: QalcRuntimeStatus; history: Record<string, number[]>; busy: boolean; message?: string; onBack: () => void; onAction: (state: "ACTIVE" | "PAUSED" | "STOPPED") => void }) {
  const f = status.features || {}; const d = status.decision || {}; const active = strategy?.desired_state === "ACTIVE";
  const localPaper = isLocalOnlyRuntime();
  const canStart = localPaper ? Boolean(strategy) : strategy?.certification_state !== "RESEARCH" && status.clock?.state === "CLOCK_SAFE";
  return <section className="qalc-cockpit"><header><button type="button" onClick={onBack}><ArrowLeft size={13} /> CONFIGURATION</button><div><span>BC-QALC / PAPER</span><h1>{strategy?.name || "Unsaved BC-QALC candidate"}</h1><p>Native event-time engine · {strategy?.symbol || "BTCUSDT"} · Bybit Linear</p></div><div className="qalc-runtime-state"><span>RUNTIME</span><strong>{status.runtimeState}</strong><em>{status.available ? status.source : "NO FALLBACK DATA"}</em></div><div className="qalc-actions">{active ? <button disabled={busy} onClick={() => onAction("PAUSED")}><Pause size={13} /> PAUSE</button> : <button disabled={busy || !canStart} title={!canStart ? "Event replay certification and a safe authoritative clock are required." : undefined} onClick={() => onAction("ACTIVE")}><Play size={13} /> START PAPER</button>}</div></header>
    <div className="qalc-certification"><LockKeyhole size={14} /><strong>{strategy?.certification_state || status.certificationState}</strong><span>{localPaper ? "Local Paper may run under RESEARCH certification; every quote and fill remains simulated and live execution is impossible." : "Live execution and Investment Group fanout remain outside this chapter."}</span></div>{message ? <div className="strategy-library-message">{message}</div> : null}
    <div className="qalc-metrics">{[["BOOK",status.book?.state || "—"],["TRADES",status.available ? "CANONICAL" : "—"],["CLOCK",status.clock?.state || "UNSAFE"],["DIRECTION",d.directional ? `${(d.directional.probabilityUp * 100).toFixed(1)}% UP` : "—"],["MOVE",d.directional ? `${d.directional.expectedMoveTicks.toFixed(2)} ticks` : "—"],["NET EDGE",d.costs ? `${money(d.costs.expectedNetEdgeUsdt)}` : "—"],["P(FILL)",d.fill ? `${(d.fill.beforeInvalidation * 100).toFixed(1)}%` : "—"],["TOXICITY",f.toxicity ? `${f.toxicity.score.toFixed(1)} / 100` : "—"],["QUOTE AGE",status.activeQuote ? `${Date.now() - status.activeQuote.createdAt} ms` : "—"],["QUEUE AHEAD",status.activeQuote ? status.activeQuote.queueAheadEstimated.toFixed(4) : "—"],["INVENTORY",status.inventory ? `${status.inventory.side} ${status.inventory.quantity}` : "FLAT"],["DAILY DD",status.risk ? `${status.risk.dailyDrawdownPercent.toFixed(2)}%` : "—"]].map(([label,value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="qalc-sparklines">{[["Queue Imbalance",history.imbalance],["Microprice Edge",history.microprice],["OFI",history.ofi],["Real CVD Impulse",history.cvd],["Replenishment",history.replenishment],["Toxicity",history.toxicity]].map(([label,values]) => <article key={label as string}><header><span>{label}</span><strong>{(values as number[]).at(-1)?.toFixed(3) || "—"}</strong></header><Spark values={values as number[]} /></article>)}</div>
    <div className="qalc-operational-grid"><Panel title="ACTIVE QUOTE">{status.activeQuote ? <><p><span>Side / Price</span><b>{status.activeQuote.side} @ {status.activeQuote.price}</b></p><p><span>State</span><b>{status.activeQuote.state}</b></p><p><span>Queue confidence</span><b>{(status.activeQuote.queueConfidence * 100).toFixed(1)}%</b></p></> : <Empty text="No Paper quote active" />}</Panel><Panel title="INVENTORY">{status.inventory ? <><p><span>Position</span><b>{status.inventory.side} {status.inventory.quantity}</b></p><p><span>Unrealized</span><b>{money(status.inventory.unrealizedPnl)}</b></p></> : <Empty text="Flat" />}</Panel><Panel title="LATEST DECISION">{d ? <><p><span>Action</span><b>{d.action || "NO QUOTE"}</b></p><p><span>Reason</span><b>{d.reason || "Awaiting canonical state"}</b></p></> : <Empty text="No decision" />}</Panel></div>
  </section>;
}

function Label({ title, children }: { title: string; children: React.ReactNode }) { return <label>{title}{children}</label>; }
function NumberField({ title, value, step = 1, onChange }: { title: string; value: number; step?: number; onChange: (value: number) => void }) { return <Label title={title}><input type="number" value={value} step={step} onChange={(event) => onChange(Number(event.target.value))} /></Label>; }
function Health({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div>{icon}<span>{label}</span><strong>{value}</strong></div>; }
function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <article><header>{title}</header><div>{children}</div></article>; }
function Empty({ text }: { text: string }) { return <div className="qalc-empty">{text}</div>; }
function Spark({ values }: { values: number[] }) { const points = useMemo(() => sparkPoints(values), [values]); return <svg viewBox="0 0 200 48" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="24" x2="200" y2="24" /><polyline points={points} /></svg>; }
function sparkPoints(values: number[]) { if (!values.length) return "0,24 200,24"; const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1; return values.map((value,index) => `${index / Math.max(1, values.length - 1) * 200},${44 - (value - min) / range * 40}`).join(" "); }
function appendHistory(current: Record<string, number[]>, status: QalcRuntimeStatus) { const f = status.features || {}; const add = (key: string, value: number) => [...(current[key] || []), Number.isFinite(value) ? value : 0].slice(-90); return { imbalance: add("imbalance", f.queueImbalance?.["5"] || 0), microprice: add("microprice", f.micropriceEdgeTicks || 0), ofi: add("ofi", f.combinedOfi?.["1000"] || 0), cvd: add("cvd", f.deltaImpulse || 0), replenishment: add("replenishment", (f.bidReplenishment || 0) - (f.askReplenishment || 0)), toxicity: add("toxicity", f.toxicity?.score || 0) }; }
function money(value: number) { return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`; }
function description(step: number) { return ["Lock the initial Bybit linear Paper market and allocate simulated capital.","Verify that canonical event data and corrected exchange time are safe before any quote.","Configure the interpretable directional, fill and adverse-selection baseline.","Bound the one-sided passive quote lifecycle and quote churn.","Keep inventory short-lived and exit when edge, time or safety invalidates it.","Set hard capital, loss and adverse-selection limits. No martingale or averaging down exists.","Model the latency actually paid by the Paper state machine.","Review the immutable safety boundary and save a private Paper candidate."][step]; }
