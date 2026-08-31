import { AlertOctagon, Plus, ShieldCheck } from "lucide-react";
import type { StrategyTargetBinding, StrategyTargetSnapshot } from "../../automation/strategyAutomation.types";
import { targetExecutionFailure } from "./targetExecutionPresentation";

type Props = {
  bindings: StrategyTargetBinding[];
  snapshots: StrategyTargetSnapshot[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onAdd?: (slotIndex: number) => void;
};

export function TargetSlotMatrix({ bindings, snapshots, selectedId, onSelect, onAdd }: Props) {
  const bySlot = new Map(bindings.filter((item) => item.status !== "DISCONNECTED").map((item) => [item.slotIndex, item]));
  const snapshotById = new Map(snapshots.map((item) => [item.bindingId, item]));
  return <section className="target-matrix-section">
    <header><div><span>AUTHORIZED DESTINATIONS</span><h2>EXECUTION TARGET MATRIX</h2></div><strong>{bySlot.size} / 9 ALLOCATED</strong></header>
    <div className="target-slot-matrix">{Array.from({ length: 9 }, (_, index) => {
      const slot = index + 1;
      const binding = bySlot.get(slot);
      const snapshot = binding ? snapshotById.get(binding.id) : undefined;
      if (!binding) return <button type="button" className="target-slot empty" key={slot} onClick={() => onAdd?.(slot)}><span>TARGET {String(slot).padStart(2, "0")}</span><em>No execution destination assigned</em><b><Plus size={11} /> ADD DESTINATION</b></button>;
      const executionFailure = targetExecutionFailure(snapshot);
      const executionContext = [executionFailure?.direction, executionFailure?.action].filter(Boolean).join(" ");
      return <button type="button" className={`target-slot occupied${selectedId === binding.id ? " selected" : ""}${executionFailure ? " execution-failed" : ""}`} key={slot} onClick={() => onSelect?.(binding.id)} title={executionFailure?.errorMessage}><span>TARGET {String(slot).padStart(2, "0")} · {binding.status}</span><strong>{binding.targetLabel || binding.targetProvider || binding.targetType}</strong><em>{executionFailure ? `${executionContext || "BROKER COMMAND"} · ${executionFailure.errorCode || "PREFLIGHT REJECTED"}` : `${snapshot?.freshness || "UNAVAILABLE"} · ${money(snapshot?.equity || 0)}`}</em><b>{executionFailure ? <><AlertOctagon size={11} /> EXECUTION FAILED</> : <><ShieldCheck size={11} /> {binding.status === "LIVE" ? "EXECUTION ACTIVE" : "NOT ARMED"}</>}</b></button>;
    })}</div>
  </section>;
}

function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
