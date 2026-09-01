import { CheckCircle2, CloudCog, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { isLocalOnlyRuntime } from "../../../../core/local-runtime/localRuntimeClient";
import type { EligibleBrokerTarget, EligibleGroupTarget, StrategyDeploymentType, StrategyTargetBinding } from "../../automation/strategyAutomation.types";
import type { StrategyWizardDraft } from "../state/strategyDraftStore";

type Eligible = { brokerAccounts: EligibleBrokerTarget[]; groups: EligibleGroupTarget[] } | null;

export function TargetsStep({ draft, bindings, eligible, busy, onRefreshTargets, onManageTargets, onChange }: {
  draft: StrategyWizardDraft;
  bindings: StrategyTargetBinding[];
  eligible: Eligible;
  busy: boolean;
  onRefreshTargets: (draft?: StrategyWizardDraft) => Promise<void>;
  onManageTargets: (targetType: "BROKER_ACCOUNT" | "INVESTMENT_GROUP", draft: StrategyWizardDraft) => Promise<void>;
  onChange: (draft: StrategyWizardDraft) => void;
}) {
  const localOnly = isLocalOnlyRuntime();
  const plan = draft.definition.deployment || { targetType: "PAPER", authorizationAccepted: false, armOnActivation: false };
  const patch = (value: Partial<typeof plan>) => onChange({ ...draft, definition: { ...draft.definition, deployment: { ...plan, ...value } } });
  const chooseType = (targetType: StrategyDeploymentType) => {
    const nextDraft: StrategyWizardDraft = {
      ...draft,
      definition: {
        ...draft.definition,
        deployment: { ...plan, targetType, targetId: undefined, targetLabel: targetType === "PAPER" ? "Paper Backtester" : undefined, authorizationAccepted: false, armOnActivation: false },
      },
    };
    onChange(nextDraft);
    if (targetType !== "PAPER" && !busy) void onRefreshTargets(nextDraft);
  };
  const candidates: Array<EligibleBrokerTarget | EligibleGroupTarget> = plan.targetType === "INVESTMENT_GROUP" ? eligible?.groups || [] : eligible?.brokerAccounts || [];
  const selected = candidates.find((candidate) => candidate.targetId === plan.targetId);
  return <div className="strategy-wizard-section">
    <header><span>09</span><div><h2>Execution destination</h2><p>Choose exactly where this private strategy runs. No broker or group is armed without explicit approval.</p></div></header>
    <div className="strategy-destination-grid">
      <Destination active={plan.targetType === "PAPER"} disabled={busy} icon={<ShieldCheck size={18} />} title="Paper Backtester" text={`${localOnly ? "Device-local" : "Black Cloud"} simulated account. No broker order can be submitted.`} onClick={() => chooseType("PAPER")} />
      <Destination active={plan.targetType === "BROKER_ACCOUNT"} disabled={busy} icon={<CloudCog size={18} />} title="Connected Broker" text="Use one eligible, synchronized account already connected to Black Terminal." onClick={() => chooseType("BROKER_ACCOUNT")} />
      <Destination active={plan.targetType === "INVESTMENT_GROUP"} disabled={busy} icon={<Users size={18} />} title="Investment Group" text="Use an owned or managed group with active execution mandates." onClick={() => chooseType("INVESTMENT_GROUP")} />
    </div>
    {plan.targetType === "PAPER" ? <section className="strategy-destination-ready"><CheckCircle2 size={17} /><div><strong>PAPER BACKTESTER SELECTED</strong><span>Activation creates an immutable version and starts its isolated Paper runtime. Live targets remain untouched.</span></div></section> : <>
      <div className="strategy-target-discovery"><div><strong>{plan.targetType === "BROKER_ACCOUNT" ? "ELIGIBLE BROKER ACCOUNTS" : "ELIGIBLE INVESTMENT GROUPS"}</strong><span>{busy ? `Saving this destination and loading authenticated ${localOnly ? "local" : "Black Cloud"} targets…` : draft.strategyId ? `Read from authenticated ${localOnly ? "device ownership and local" : "Black Cloud ownership and"} readiness state.` : "This draft will be saved automatically before target eligibility is checked."}</span></div><div className="strategy-target-discovery-actions"><button type="button" disabled={busy} onClick={() => void onRefreshTargets(draft)}><RefreshCw size={13} /> {busy ? "LOADING…" : "REFRESH"}</button><button type="button" className="strategy-target-add" aria-label={plan.targetType === "BROKER_ACCOUNT" ? "Add or manage broker connections" : "Select an investment group"} title={plan.targetType === "BROKER_ACCOUNT" ? "Add or manage up to 9 broker connections" : "Select an investment group"} disabled={busy} onClick={() => void onManageTargets(plan.targetType as "BROKER_ACCOUNT" | "INVESTMENT_GROUP", draft)}><Plus size={14} /></button></div></div>
      <div className="eligible-target-list wizard-target-list">{candidates.map((candidate) => <button type="button" key={`${candidate.targetType}:${candidate.targetId}`} className={plan.targetId === candidate.targetId ? "selected" : ""} disabled={!candidate.validation.eligible || busy} onClick={() => patch({ targetId: candidate.targetId, targetLabel: candidate.label, authorizationAccepted: false, armOnActivation: false })}><span>{candidate.targetType === "BROKER_ACCOUNT" ? `${candidate.provider} · ${candidate.environment}` : "INVESTMENT GROUP"}</span><strong>{candidate.label}</strong><em>{candidate.validation.eligible ? "Eligible and owner-authorized" : candidate.validation.reasons.join(" · ")}</em></button>)}</div>
      {eligible && candidates.length === 0 ? <div className="cockpit-empty-state compact"><strong>No eligible destination found</strong><span>{plan.targetType === "BROKER_ACCOUNT" ? "Use the + control to enable an existing Black Terminal broker or add a trade-only Bybit connection." : "Use the + control to select a user-created Investment Group mandate."}</span></div> : null}
      {selected ? <div className="strategy-target-approval"><label className="wizard-toggle"><span><strong>AUTHORIZE THIS DESTINATION</strong><em>I approve {selected.label} as the execution destination for this private strategy configuration.</em></span><input type="checkbox" checked={plan.authorizationAccepted} onChange={(event) => patch({ authorizationAccepted: event.target.checked })} /></label><label className="wizard-toggle"><span><strong>ARM AFTER ACTIVATION</strong><em>After validation, bind and arm this target. Leave disabled to create a READY binding for later manual arming.</em></span><input type="checkbox" checked={plan.armOnActivation} disabled={!plan.authorizationAccepted} onChange={(event) => patch({ armOnActivation: event.target.checked })} /></label></div> : null}
    </>}
    {bindings.length ? <p className="target-matrix-note">Existing bindings: {bindings.map((binding) => `${binding.targetLabel || binding.targetType} · ${binding.status}`).join(" / ")}. A new immutable version never silently reassigns them.</p> : null}
  </div>;
}

function Destination({ active, disabled, icon, title, text, onClick }: { active: boolean; disabled: boolean; icon: React.ReactNode; title: string; text: string; onClick: () => void }) {
  return <button type="button" className={active ? "active" : ""} disabled={disabled} onClick={onClick}>{icon}<strong>{title}</strong><span>{text}</span></button>;
}
