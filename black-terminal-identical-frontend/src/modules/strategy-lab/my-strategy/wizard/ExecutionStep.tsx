import { useState } from "react";
import type { StrategyWizardDraft } from "../state/strategyDraftStore";

export function ExecutionStep({ draft, onChange }: { draft: StrategyWizardDraft; onChange: (draft: StrategyWizardDraft) => void }) {
  const [advanced, setAdvanced] = useState(false);
  const execution = draft.definition.execution;
  const patch = (key: string, value: unknown) => onChange({ ...draft, definition: { ...draft.definition, execution: { ...execution, [key]: value } } });
  return <div className="strategy-wizard-section">
    <header><span>04</span><div><h2>Execution behavior</h2><p>Define how confirmed signals behave without exposing the internal state machine.</p></div></header>
    <div className="strategy-toggle-list">
      <Toggle label="Ignore repeated duplicate alerts" text="A repeated signal in the held direction will not close and reopen the position." checked={execution.ignoreDuplicateAlerts !== false} onChange={(value) => patch("ignoreDuplicateAlerts", value)} />
      {draft.definition.marketType === "FUTURES" ? <Toggle label="Ongoing Perpetual Signal Reversal" text="An opposite entry alert closes the current position first, waits for confirmed closure, then opens the opposite direction. Disabled by default." checked={execution.perpetualSignalReversalEnabled === true} onChange={(value) => onChange({ ...draft, definition: { ...draft.definition, execution: { ...execution, perpetualSignalReversalEnabled: value, conflictResolution: value ? "CLOSE_THEN_REVERSE" : execution.conflictResolution } } })} /> : null}
    </div>
    <div className="strategy-form-grid">
      <Select label="SAME-DIRECTION SIGNAL POLICY" value={String(execution.sameDirectionPolicy || "IGNORE")} options={[["IGNORE", "Ignore"], ["SCALE_IN", "Scale In"], ["REFRESH_PROTECTION", "Refresh Protection"]]} onChange={(value) => patch("sameDirectionPolicy", value)} />
      <Select label="SIGNAL TIMING" value={String(execution.signalTiming || "CONFIRMED_BAR")} options={[["CONFIRMED_BAR", "Confirmed Bar Close"], ["NEXT_OPEN", "Next Bar Open"]]} onChange={(value) => patch("signalTiming", value)} />
      <NumberField label="SIGNAL EXPIRY" value={Number(execution.signalExpiryBars || 1)} suffix="bars" min={1} onChange={(value) => patch("signalExpiryBars", value)} />
      <Select label="OPPOSITE SIGNAL WITHOUT REVERSAL" value={String(execution.conflictResolution === "IGNORE" ? "IGNORE" : "CLOSE_ONLY")} options={[["IGNORE", "Ignore Opposite Signal"], ["CLOSE_ONLY", "Close Current Position"]]} onChange={(value) => patch("conflictResolution", value)} />
    </div>
    <button className="advanced-disclosure" type="button" onClick={() => setAdvanced((open) => !open)}>{advanced ? "HIDE" : "SHOW"} ADVANCED EXECUTION SETTINGS</button>
    {advanced && draft.definition.marketType === "FUTURES" ? <div className="experimental-box"><Toggle label="Stop-Loss Revenge Reversal" text="After a confirmed stop fill, reverse once within the bounded chain. The reverse closes on its stop or the mapped opposite alert. Disabled by default." checked={execution.stopReversalEnabled === true} onChange={(value) => patch("stopReversalEnabled", value)} /><div className="strategy-form-grid"><NumberField label="MAXIMUM REVERSAL CHAIN" value={Number(execution.maximumReversalChain || 1)} min={1} max={5} onChange={(value) => patch("maximumReversalChain", value)} /><NumberField label="MAX REVERSALS / DAY" value={Number(execution.maximumReversalsPerDay || 2)} min={1} max={20} onChange={(value) => patch("maximumReversalsPerDay", value)} /><NumberField label="COOLDOWN" value={Number(execution.reversalCooldownBars ?? 0)} suffix="bars" min={0} onChange={(value) => patch("reversalCooldownBars", value)} /><NumberField label="MAX CONSECUTIVE LOSSES" value={Number(execution.maximumConsecutiveLosses || 3)} min={1} onChange={(value) => patch("maximumConsecutiveLosses", value)} /></div><p className="risk-consequence">Close-before-reverse is mandatory. Duplicate stop events use deterministic identities, and every global loss/drawdown limit still suspends new reverse entries.</p></div> : null}
  </div>;
}

function Toggle({ label, text, checked, onChange }: { label: string; text: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="wizard-toggle"><span><strong>{label}</strong><em>{text}</em></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>; }
export function NumberField({ label, value, suffix, min, max, step = 1, onChange }: { label: string; value: number; suffix?: string; min?: number; max?: number; step?: number; onChange: (value: number) => void }) { return <label>{label}<span className="number-with-suffix"><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />{suffix ? <b>{suffix}</b> : null}</span></label>; }
function Select({ label, value, options, onChange }: { label: string; value: string; options: string[][]; onChange: (value: string) => void }) { return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>; }
