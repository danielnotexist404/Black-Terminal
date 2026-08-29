import { ArrowLeft, ArrowRight, Check, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { StrategyAutomationDefinition } from "../../automation/strategyAutomation.types";
import type { StrategyIndicatorInstance } from "../state/indicatorManifest";
import { validateWizardStep, wizardSteps, type StrategyWizardDraft } from "../state/strategyDraftStore";
import { ExecutionStep } from "../wizard/ExecutionStep";
import { IndicatorMarketStep } from "../wizard/IndicatorMarketStep";
import { ReviewStep } from "../wizard/ReviewStep";
import { SignalMappingStep } from "../wizard/SignalMappingStep";

type Props = {
  draft: StrategyWizardDraft;
  chartTimeframe: string;
  indicators: StrategyIndicatorInstance[];
  publishedName?: string;
  publishedDefinition?: StrategyAutomationDefinition | null;
  saving: boolean;
  message?: string;
  onChange: (draft: StrategyWizardDraft) => void;
  onSaveDraft: () => void;
  onActivate: () => void;
  onCancel: () => void;
};

export function StrategyWizardPage(props: Props) {
  const [step, setStep] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const finalIssues = step === wizardSteps.length - 1 ? validateWizardStep(props.draft, step) : [];
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") props.onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [props.onCancel]);
  const go = (next: number) => {
    if (next > step) {
      const nextIssues = validateWizardStep(props.draft, step);
      if (nextIssues.length) { setIssues(nextIssues); return; }
    }
    setIssues([]);
    setStep(Math.max(0, Math.min(wizardSteps.length - 1, next)));
  };
  return <section className="strategy-wizard" aria-label="Create strategy wizard">
    <header className="strategy-wizard-head"><div><span>{props.draft.strategyId ? "EDIT CONFIGURATION" : "CREATE NEW STRATEGY"}</span><strong>{props.draft.name.trim() || "Untitled Strategy"}</strong><em>DRAFT VERSION {props.draft.publishedVersion ? props.draft.publishedVersion + 1 : 1}</em></div><button type="button" aria-label="Cancel strategy wizard" disabled={props.saving} onClick={props.onCancel}><X size={17} /></button></header>
    <div className="strategy-wizard-layout">
      <nav className="strategy-wizard-stepper" aria-label="Strategy wizard steps">{wizardSteps.map((label, index) => <button type="button" key={label} className={`${index === step ? "active" : ""}${index < step ? " complete" : ""}`} onClick={() => go(index)}><span>{index < step ? <Check size={12} /> : String(index + 1).padStart(2, "0")}</span><strong>{label}</strong></button>)}</nav>
      <main className="strategy-wizard-main">
        {step === 0 ? <IndicatorMarketStep draft={props.draft} chartTimeframe={props.chartTimeframe} indicators={props.indicators} onChange={props.onChange} /> : null}
        {step === 1 ? <SignalMappingStep draft={props.draft} onChange={props.onChange} /> : null}
        {step === 2 ? <ExecutionStep draft={props.draft} onChange={props.onChange} /> : null}
        {step === 3 ? <ReviewStep draft={props.draft} publishedName={props.publishedName} publishedDefinition={props.publishedDefinition} /> : null}
        {issues.length ? <div className="wizard-inline-errors">{issues.map((issue) => <span key={issue}>{issue}</span>)}</div> : null}
        {props.message ? <div className="wizard-save-state" role="status">{props.message}</div> : null}
        <footer>
          <button type="button" disabled={props.saving} onClick={props.onCancel}>CANCEL</button>
          {step < wizardSteps.length - 1 ? <button type="button" disabled={props.saving} onClick={props.onSaveDraft}><Save size={13} /> SAVE DRAFT</button> : null}
          <span />
          {step > 0 ? <button type="button" disabled={props.saving} onClick={() => go(step - 1)}><ArrowLeft size={13} /> BACK</button> : null}
          {step < wizardSteps.length - 1
            ? <button type="button" className="primary" disabled={props.saving} onClick={() => go(step + 1)}>CONTINUE <ArrowRight size={13} /></button>
            : <button type="button" className="primary strategy-wizard-complete" disabled={props.saving || finalIssues.length > 0} onClick={props.onActivate}><Save size={13} /> {props.saving ? "SAVING & OPENING…" : "SAVE STRATEGY & OPEN COCKPIT"}</button>}
        </footer>
      </main>
      <aside className="strategy-wizard-summary"><span>STRATEGY SUMMARY</span><Summary label="Name" value={props.draft.name || "Selected script name"} /><Summary label="Signal source" value={props.draft.definition.indicator?.name || "Not selected"} /><Summary label="Currency" value={`Bybit ${props.draft.definition.symbol}`} /><Summary label="Runtime TF" value={props.draft.definition.timeframe.toUpperCase()} /><Summary label="Market" value={props.draft.definition.marketType} /><Summary label="Execution" value="Not connected · configure after save" /><div className="wizard-version-summary"><strong>Configuration V{props.draft.publishedVersion ? props.draft.publishedVersion + 1 : 1}</strong><span>Saved {props.draft.publishedVersion ? `V${props.draft.publishedVersion}` : "—"}</span><span>Active {props.draft.runningVersion ? `V${props.draft.runningVersion}` : "—"}</span></div></aside>
    </div>
  </section>;
}

function Summary({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
