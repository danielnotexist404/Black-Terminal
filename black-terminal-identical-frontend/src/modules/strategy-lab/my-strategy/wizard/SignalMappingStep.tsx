import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { StrategyIndicatorAlert, StrategySignalMappings } from "../../automation/strategyAutomation.types";
import type { StrategyWizardDraft } from "../state/strategyDraftStore";

export function SignalMappingStep({ draft, onChange }: { draft: StrategyWizardDraft; onChange: (draft: StrategyWizardDraft) => void }) {
  const alerts = draft.definition.indicator?.alerts || [];
  const mappings = draft.definition.signals || {};
  const setMapping = (key: keyof StrategySignalMappings, value: string) => onChange({ ...draft, definition: { ...draft.definition, signals: { ...mappings, [key]: value || undefined } } });
  const futures = draft.definition.marketType === "FUTURES";
  return <div className="strategy-wizard-section">
    <header><span>02</span><div><h2>Signal mapping</h2><p>Map the strategy's native events to long, short and optional close actions. Labels never become runtime identities.</p></div></header>
    {!draft.definition.indicator ? <State icon={<AlertTriangle size={18} />} title="Select an indicator first" text="Return to Indicator and Market to load its alert manifest." /> : alerts.length === 0 ? <State icon={<AlertTriangle size={18} />} title="No strategy alerts available" text="This indicator has no alert manifest and cannot be published for automation." /> : <>
      <div className="strategy-form-grid signal-map-grid">
        {futures ? <>
          <AlertSelect label="LONG TRIGGER ENTRY" required semantic="LONG_ENTRY" value={mappings.longEntry} alerts={alerts} onChange={(value) => setMapping("longEntry", value)} />
          <AlertSelect label="SHORT TRIGGER ENTRY" required semantic="SHORT_ENTRY" value={mappings.shortEntry} alerts={alerts} onChange={(value) => setMapping("shortEntry", value)} />
          <AlertSelect label="LONG EXIT TRIGGER" semantic="LONG_EXIT" value={mappings.longExit} alerts={alerts} onChange={(value) => setMapping("longExit", value)} />
          <AlertSelect label="SHORT EXIT TRIGGER" semantic="SHORT_EXIT" value={mappings.shortExit} alerts={alerts} onChange={(value) => setMapping("shortExit", value)} />
        </> : <>
          <AlertSelect label="BUY TRIGGER ENTRY" required semantic="LONG_ENTRY" value={mappings.buyEntry} alerts={alerts} onChange={(value) => setMapping("buyEntry", value)} />
          <AlertSelect label="SELL TRIGGER ENTRY" required semantic="SHORT_ENTRY" value={mappings.sellExit} alerts={alerts} onChange={(value) => setMapping("sellExit", value)} />
        </>}
      </div>
      <div className={`runtime-readiness ${draft.definition.indicator.runtimeStatus === "CERTIFIED" ? "ready" : "blocked"}`}>{draft.definition.indicator.runtimeStatus === "CERTIFIED" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}<div><strong>{draft.definition.indicator.runtimeStatus === "CERTIFIED" ? "Confirmed-bar runtime compatible" : "Saved strategy · runtime certification pending"}</strong><span>{draft.definition.indicator.runtimeStatus === "CERTIFIED" ? `Manifest ${draft.definition.indicator.alertManifestVersion} will be pinned to the published version.` : "The strategy and its native settings can be saved now; Paper and live arming remain unavailable until its headless runtime is certified."}</span></div></div>
    </>}
  </div>;
}

function AlertSelect({ label, required, semantic, value, alerts, onChange }: { label: string; required?: boolean; semantic: StrategyIndicatorAlert["semantic"]; value?: string; alerts: StrategyIndicatorAlert[]; onChange: (value: string) => void }) {
  const selected = alerts.find((alert) => alert.id === value);
  const compatible = alerts.filter((alert) => alert.semantic === semantic || (semantic === "LONG_ENTRY" && alert.semantic === "BUY") || (semantic === "SHORT_ENTRY" && alert.semantic === "SELL"));
  return <label className={required && !value ? "invalid" : ""}>{label} {required ? <b>REQUIRED</b> : <b>OPTIONAL</b>}<select value={value || ""} onChange={(event) => onChange(event.target.value)}><option value="">Select alert</option>{compatible.map((alert) => <option key={alert.id} value={alert.id}>{alert.name} · {alert.confirmedBar ? "CONFIRMED BAR" : "INTRABAR"}</option>)}</select><em>{selected ? selected.description : required ? "Select a compatible alert to continue." : "No alert means exits use protection rules."}</em></label>;
}

function State({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="strategy-step-empty">{icon}<strong>{title}</strong><span>{text}</span></div>; }
