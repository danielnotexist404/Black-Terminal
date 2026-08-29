import type { StrategyWizardDraft } from "../state/strategyDraftStore";

export function ExecutionStep({ draft, onChange }: { draft: StrategyWizardDraft; onChange: (draft: StrategyWizardDraft) => void }) {
  const execution = draft.definition.execution;
  const patch = (values: Record<string, unknown>) => onChange({ ...draft, definition: { ...draft.definition, execution: { ...execution, ...values } } });
  const stopEnabled = execution.stopLossEnabled === true;
  const stopMode = String(execution.longStopMode || "PRICE_PERCENT");
  const stopValue = Number(execution.longStopValue || draft.definition.settings.stopLossPercent || 1);
  return <div className="strategy-wizard-section">
    <header><span>03</span><div><h2>Optional trade behavior</h2><p>The script keeps ownership of its native risk management and partial take profits. These controls are optional strategy-level overrides.</p></div></header>
    <div className="strategy-toggle-list compact-behavior-list">
      <Toggle label="Optional Stop Loss Override" text="Add one strategy-level protective stop. Leave this off to use only the stop logic already written inside the strategy." checked={stopEnabled} onChange={(checked) => patch({ stopLossEnabled: checked, ...(checked ? { longStopMode: stopMode, shortStopMode: stopMode, longStopValue: stopValue, shortStopValue: stopValue } : {}) })} />
      {stopEnabled ? <div className="strategy-form-grid optional-stop-fields"><label>STOP CALCULATION<select value={stopMode} onChange={(event) => patch({ longStopMode: event.target.value, shortStopMode: event.target.value })}>{stopModes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><NumberField label="STOP VALUE" value={stopValue} min={0.01} step={0.01} onChange={(value) => patch({ longStopValue: value, shortStopValue: value })} /></div> : null}
      {draft.definition.marketType === "FUTURES" ? <Toggle label="Revenge Mode" text="After a confirmed stop fill, close first and flip once. The reverse closes on its own stop or the mapped opposite signal." checked={execution.stopReversalEnabled === true} onChange={(stopReversalEnabled) => patch({ stopReversalEnabled, maximumReversalChain: stopReversalEnabled ? 1 : execution.maximumReversalChain })} /> : null}
      {draft.definition.marketType === "FUTURES" ? <Toggle label="Ongoing Perpetual Trades" text="Every opposite entry signal closes the open side and immediately reverses it, continuously." checked={execution.perpetualSignalReversalEnabled === true} onChange={(perpetualSignalReversalEnabled) => patch({ perpetualSignalReversalEnabled, conflictResolution: perpetualSignalReversalEnabled ? "CLOSE_THEN_REVERSE" : "CLOSE_ONLY" })} /> : null}
    </div>
  </div>;
}

function Toggle({ label, text, checked, onChange }: { label: string; text: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="wizard-toggle"><span><strong>{label}</strong><em>{text}</em></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>; }
export function NumberField({ label, value, suffix, min, max, step = 1, onChange }: { label: string; value: number; suffix?: string; min?: number; max?: number; step?: number; onChange: (value: number) => void }) { return <label>{label}<span className="number-with-suffix"><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />{suffix ? <b>{suffix}</b> : null}</span></label>; }

const stopModes = [["PRICE_PERCENT", "Price percentage (%)"], ["ATR_MULTIPLE", "ATR multiple"], ["FIXED_USDT", "Fixed USDT loss"], ["INDICATOR_ALERT", "Mapped indicator stop event"]] as const;
