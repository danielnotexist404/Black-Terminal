import type { StrategyWizardDraft } from "../state/strategyDraftStore";

export function IdentityStep({ draft, onChange }: { draft: StrategyWizardDraft; onChange: (draft: StrategyWizardDraft) => void }) {
  const nameIssue = draft.name.trim().length < 2 ? "Use at least 2 characters." : draft.name.trim().length > 80 ? "Maximum 80 characters." : "";
  return <div className="strategy-wizard-section">
    <header><span>01</span><div><h2>Name the strategy</h2><p>Choose one clear identity. A new strategy begins as Draft Version 1.</p></div></header>
    <div className="strategy-form-grid">
      <label className={nameIssue ? "invalid" : ""}>STRATEGY NAME <b>REQUIRED</b><input autoFocus value={draft.name} maxLength={80} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="Example: BTC 4H Distribution Reversal" /><em>{nameIssue || `${draft.name.trim().length} / 80`}</em></label>
      <label>DESCRIPTION <b>OPTIONAL</b><textarea value={draft.description} maxLength={2_000} onChange={(event) => onChange({ ...draft, description: event.target.value, definition: { ...draft.definition, metadata: { ...draft.definition.metadata, description: event.target.value } } })} placeholder="Explain the strategy's purpose and intended market regime." /></label>
      <label className="wide">TAGS <b>OPTIONAL</b><input value={draft.tags.join(", ")} onChange={(event) => {
        const tags = event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 20);
        onChange({ ...draft, tags, definition: { ...draft.definition, metadata: { ...draft.definition.metadata, tags } } });
      }} placeholder="swing, confirmed-bar, bitcoin" /><em>Separate tags with commas.</em></label>
    </div>
  </div>;
}
