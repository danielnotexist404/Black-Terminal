import { LockKeyhole, Plus } from "lucide-react";
import type { StrategyTargetBinding, StrategyTargetSnapshot } from "../../automation/strategyAutomation.types";

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
    <header><div><span>LIVE TARGETS</span><h2>DYNAMIC 10-SLOT MATRIX</h2></div><strong>{bySlot.size} / 10 ALLOCATED</strong></header>
    <div className="target-slot-matrix">{Array.from({ length: 10 }, (_, index) => {
      const slot = index + 1;
      const binding = bySlot.get(slot);
      const snapshot = binding ? snapshotById.get(binding.id) : undefined;
      if (!binding) return <button type="button" className="target-slot empty" key={slot} onClick={() => onAdd?.(slot)}><span>TARGET {String(slot).padStart(2, "0")}</span><em>No live account allocated</em><b><Plus size={11} /> ADD ACCOUNT OR GROUP</b></button>;
      return <button type="button" className={`target-slot occupied${selectedId === binding.id ? " selected" : ""}`} key={slot} onClick={() => onSelect?.(binding.id)}><span>TARGET {String(slot).padStart(2, "0")} · {binding.status}</span><strong>{binding.targetLabel || binding.targetProvider || binding.targetType}</strong><em>{snapshot?.freshness || "UNAVAILABLE"} · {money(snapshot?.equity || 0)}</em><b><LockKeyhole size={11} /> LIVE EXECUTION LOCKED</b></button>;
    })}</div>
  </section>;
}

function money(value: number) { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
