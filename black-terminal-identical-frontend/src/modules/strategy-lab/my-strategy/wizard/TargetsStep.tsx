import { LockKeyhole, Plus } from "lucide-react";
import type { StrategyTargetBinding } from "../../automation/strategyAutomation.types";
import type { StrategyWizardDraft } from "../state/strategyDraftStore";

export function TargetsStep({ bindings }: { draft: StrategyWizardDraft; bindings: StrategyTargetBinding[] }) {
  const bySlot = new Map(bindings.filter((binding) => binding.status !== "DISCONNECTED").map((binding) => [binding.slotIndex, binding]));
  return <div className="strategy-wizard-section"><header><span>09</span><div><h2>Live targets</h2><p>Paper is separate. Real accounts remain optional, unarmed and locked in this preview.</p></div></header>
    <div className="target-boundary"><div><strong>PAPER TARGET</strong><span>Configured in the previous step</span></div><div><LockKeyhole size={15} /><strong>LIVE TRADING NOT YET CERTIFIED</strong><span>New targets remain at 0% allocation and cannot submit orders.</span></div></div>
    <div className="target-matrix-head"><span>TEN EMPTY LIVE TARGET SLOTS</span><b>{bindings.length} / 10 allocated</b></div>
    <div className="wizard-target-matrix">{Array.from({ length: 10 }, (_, index) => { const slot = index + 1; const binding = bySlot.get(slot); return <article key={slot} className={binding ? "occupied" : "empty"}><span>TARGET {String(slot).padStart(2, "0")}</span>{binding ? <><strong>{binding.targetLabel || binding.targetType.replaceAll("_", " ")}</strong><em>{binding.status} · Allocation {binding.capitalPolicy.strategyAllocationValue}% · NOT ARMED</em></> : <><strong>No live account allocated</strong><button type="button" disabled title="Publish and open the Live Targets cockpit to add an account safely"><Plus size={12} /> ADD ACCOUNT OR GROUP</button></>}</article>; })}</div>
    <p className="target-matrix-note">Empty slots create no database rows, subscriptions or runtime panels. An occupied target creates one compact cockpit after publishing.</p>
  </div>;
}
