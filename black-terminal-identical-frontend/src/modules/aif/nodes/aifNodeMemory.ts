import type { AifAuctionNode, AifLvnZone, AifTimelineEvent } from "../core/aifTypes";

type AifResearchMemory = { version: 1; nodes: AifAuctionNode[]; events: AifTimelineEvent[]; updatedAt: number };

export function mergeAifResearchMemory(key: string, nodes: AifAuctionNode[], events: AifTimelineEvent[], storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  const previous = readAifResearchMemory(key, storage);
  const nodeMap = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const old = nodeMap.get(node.id);
    nodeMap.set(node.id, old ? { ...node, firstObserved: old.firstObserved, touchCount: Math.max(old.touchCount, node.touchCount), tested: old.tested || node.tested, status: node.status === "untested" ? old.status : node.status } : node);
  }
  const eventMap = new Map(previous.events.map((event) => [event.id, event]));
  for (const event of events) eventMap.set(event.id, event);
  const memory: AifResearchMemory = { version: 1, nodes: [...nodeMap.values()].sort((a, b) => b.lastObserved - a.lastObserved).slice(0, 120), events: [...eventMap.values()].sort((a, b) => a.time - b.time).slice(-180), updatedAt: Date.now() };
  persistWithFallback(storage, `bt_aif_memory:${key}`, memory, { ...memory, nodes: memory.nodes.slice(0, 24), events: memory.events.slice(-60) });
  return memory;
}

type AifZoneMemory = { version: 1; zones: AifLvnZone[]; updatedAt: number };

export function mergeAifLvnZoneMemory(key: string, zones: AifLvnZone[], storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  const previous = readAifLvnZoneMemory(key, storage);
  const unmatched = [...previous.zones];
  const merged = zones.map((zone) => {
    const matchIndex = unmatched.findIndex((candidate) => candidate.profileType === zone.profileType && (zoneOverlap(candidate, zone) >= 0.35 || normalizedCenterDistance(candidate, zone) <= 1.5));
    if (matchIndex < 0) return zone;
    const old = unmatched.splice(matchIndex, 1)[0];
    return {
      ...zone,
      id: old.id,
      firstObserved: old.firstObserved,
      touchCount: Math.max(old.touchCount, zone.touchCount),
      rejectionCount: Math.max(old.rejectionCount, zone.rejectionCount),
      acceptanceCount: Math.max(old.acceptanceCount, zone.acceptanceCount),
      state: zone.state === "qualified" ? old.state : zone.state,
      invalidated: old.invalidated || zone.invalidated
    };
  });
  const retained = unmatched.filter((zone) => !zone.invalidated).slice(0, 24);
  const memory: AifZoneMemory = { version: 1, zones: [...merged, ...retained].sort((a, b) => b.lastObserved - a.lastObserved).slice(0, 48), updatedAt: Date.now() };
  persistWithFallback(storage, `bt_aif_zone_memory:${key}`, memory, { ...memory, zones: memory.zones.slice(0, 16) });
  return memory;
}

export function readAifLvnZoneMemory(key: string, storage: Pick<Storage, "getItem"> = localStorage): AifZoneMemory {
  try {
    const parsed = JSON.parse(storage.getItem(`bt_aif_zone_memory:${key}`) ?? "null") as AifZoneMemory | null;
    return parsed?.version === 1 && Array.isArray(parsed.zones) ? parsed : { version: 1, zones: [], updatedAt: 0 };
  } catch {
    return { version: 1, zones: [], updatedAt: 0 };
  }
}

function zoneOverlap(left: AifLvnZone, right: AifLvnZone) { const overlap = Math.max(0, Math.min(left.high, right.high) - Math.max(left.low, right.low)); const union = Math.max(left.high, right.high) - Math.min(left.low, right.low); return union > 0 ? overlap / union : 0; }
function normalizedCenterDistance(left: AifLvnZone, right: AifLvnZone) { return Math.abs(left.center - right.center) / Math.max(left.widthAbsolute, right.widthAbsolute, 1e-12); }

function persistWithFallback<T>(storage: Pick<Storage, "setItem">, key: string, value: T, fallback: T) {
  try { storage.setItem(key, JSON.stringify(value)); return; } catch { /* Retry with a compact snapshot. */ }
  try { storage.setItem(key, JSON.stringify(fallback)); } catch { /* Research persistence is optional; live calculation is not. */ }
}

export function readAifResearchMemory(key: string, storage: Pick<Storage, "getItem"> = localStorage): AifResearchMemory {
  try {
    const value = storage.getItem(`bt_aif_memory:${key}`);
    if (!value) return { version: 1, nodes: [], events: [], updatedAt: 0 };
    const parsed = JSON.parse(value) as AifResearchMemory;
    return parsed?.version === 1 && Array.isArray(parsed.nodes) && Array.isArray(parsed.events) ? parsed : { version: 1, nodes: [], events: [], updatedAt: 0 };
  } catch {
    return { version: 1, nodes: [], events: [], updatedAt: 0 };
  }
}
