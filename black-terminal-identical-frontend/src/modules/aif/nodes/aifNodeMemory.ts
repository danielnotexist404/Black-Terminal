import type { AifAuctionNode, AifTimelineEvent } from "../core/aifTypes";

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
  const memory: AifResearchMemory = { version: 1, nodes: [...nodeMap.values()].sort((a, b) => b.lastObserved - a.lastObserved).slice(0, 300), events: [...eventMap.values()].sort((a, b) => a.time - b.time).slice(-500), updatedAt: Date.now() };
  storage.setItem(`bt_aif_memory:${key}`, JSON.stringify(memory));
  return memory;
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
