export const DOM_PRO_LAYOUT_VERSION = 1;

export type DomWorkspacePanelId =
  | "ladder"
  | "volume-profile"
  | "liquidity-heatmap"
  | "wall-detection"
  | "trade-tape"
  | "dom-metrics"
  | "heuristic-cvd"
  | "performance"
  | "depth-chart"
  | "liquidity-flow-delta"
  | "execution";

export type DomPanelLayoutNode = {
  kind: "panel";
  panelId: DomWorkspacePanelId;
  minWidth: number;
  minHeight: number;
};

export type DomSplitNode = {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  minRatio: number;
  maxRatio: number;
  first: DomSplitNode | DomPanelLayoutNode;
  second: DomSplitNode | DomPanelLayoutNode;
};

export type DomPanelLayoutState = {
  collapsed: boolean;
  visible: boolean;
};

export type DomProLayoutPreset = "scalper" | "intraday" | "institutional" | "macro" | "compact-execution" | "analysis-focus";

export type DomProLayoutState = {
  version: number;
  workspaceId: string;
  preset: DomProLayoutPreset;
  rootSplit: DomSplitNode;
  upperSplit: DomSplitNode;
  bottomSplit: DomSplitNode;
  panelStates: Record<DomWorkspacePanelId, DomPanelLayoutState>;
  maximizedPanel: DomWorkspacePanelId | null;
  autoSave: boolean;
  updatedAt: number;
};

type LayoutStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length">;

function browserStorage(): LayoutStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

const panelMinimums: Record<DomWorkspacePanelId, [number, number]> = {
  ladder: [170, 180],
  "volume-profile": [170, 180],
  "liquidity-heatmap": [320, 240],
  "wall-detection": [170, 170],
  "trade-tape": [180, 150],
  "dom-metrics": [170, 150],
  "heuristic-cvd": [180, 120],
  performance: [170, 120],
  "depth-chart": [240, 130],
  "liquidity-flow-delta": [240, 130],
  execution: [260, 150]
};

const upperPanels: DomWorkspacePanelId[] = ["ladder", "volume-profile", "liquidity-heatmap", "wall-detection", "trade-tape", "dom-metrics"];
const bottomPanels: DomWorkspacePanelId[] = ["depth-chart", "liquidity-flow-delta", "execution"];

function panel(panelId: DomWorkspacePanelId): DomPanelLayoutNode {
  const [minWidth, minHeight] = panelMinimums[panelId];
  return { kind: "panel", panelId, minWidth, minHeight };
}

function sequentialSplit(prefix: string, panels: DomWorkspacePanelId[], weights: number[], direction: DomSplitNode["direction"]): DomSplitNode {
  if (panels.length < 2 || panels.length !== weights.length) throw new Error("Invalid DOM Pro split definition");
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const ratio = weights[0] / total;
  return {
    kind: "split",
    id: `${prefix}-${panels[0]}`,
    direction,
    ratio,
    minRatio: Math.min(0.42, Math.max(0.08, ratio * 0.42)),
    maxRatio: Math.max(0.58, Math.min(0.86, ratio * 1.9)),
    first: panel(panels[0]),
    second: panels.length === 2
      ? panel(panels[1])
      : sequentialSplit(prefix, panels.slice(1), weights.slice(1), direction)
  };
}

const presetGeometry: Record<DomProLayoutPreset, { upperHeight: number; upper: number[]; bottom: number[] }> = {
  scalper: { upperHeight: 0.69, upper: [1.08, 0.78, 1.45, 0.72, 1.25, 0.88], bottom: [0.95, 0.9, 1.25] },
  intraday: { upperHeight: 0.72, upper: [1.02, 0.88, 1.68, 0.78, 1.02, 0.88], bottom: [1.0, 1.05, 1.0] },
  institutional: { upperHeight: 0.70, upper: [1.03, 0.9, 1.82, 0.82, 0.96, 0.86], bottom: [1.0, 1.12, 0.92] },
  macro: { upperHeight: 0.76, upper: [0.92, 1.02, 2.05, 0.78, 0.82, 0.78], bottom: [1.08, 1.16, 0.8] },
  "compact-execution": { upperHeight: 0.76, upper: [1.0, 0.95, 1.95, 0.8, 0.92, 0.82], bottom: [1.18, 1.18, 0.68] },
  "analysis-focus": { upperHeight: 0.82, upper: [0.9, 1.02, 2.25, 0.82, 0.72, 0.7], bottom: [1.15, 1.25, 0.6] }
};

export function createDomProLayout(workspaceId: string, preset: DomProLayoutPreset = "institutional"): DomProLayoutState {
  const geometry = presetGeometry[preset];
  const panelStates = Object.fromEntries(Object.keys(panelMinimums).map((panelId) => [panelId, { collapsed: false, visible: true }])) as Record<DomWorkspacePanelId, DomPanelLayoutState>;
  return {
    version: DOM_PRO_LAYOUT_VERSION,
    workspaceId,
    preset,
    rootSplit: {
      kind: "split",
      id: "workspace-upper-bottom",
      direction: "horizontal",
      ratio: geometry.upperHeight,
      minRatio: 0.56,
      maxRatio: 0.86,
      first: panel("liquidity-heatmap"),
      second: panel("execution")
    },
    upperSplit: sequentialSplit("upper", upperPanels, geometry.upper, "vertical"),
    bottomSplit: sequentialSplit("bottom", bottomPanels, geometry.bottom, "vertical"),
    panelStates,
    maximizedPanel: null,
    autoSave: true,
    updatedAt: Date.now()
  };
}

export function applyDomProLayoutPreset(state: DomProLayoutState, preset: DomProLayoutPreset): DomProLayoutState {
  const next = createDomProLayout(state.workspaceId, preset);
  return { ...next, autoSave: state.autoSave, panelStates: { ...next.panelStates, ...state.panelStates }, updatedAt: Date.now() };
}

export function findDomSplit(node: DomSplitNode | DomPanelLayoutNode, splitId: string): DomSplitNode | null {
  if (node.kind === "panel") return null;
  if (node.id === splitId) return node;
  return findDomSplit(node.first, splitId) ?? findDomSplit(node.second, splitId);
}

function patchSplit(node: DomSplitNode, splitId: string, patch: (split: DomSplitNode) => DomSplitNode): DomSplitNode {
  if (node.id === splitId) return patch(node);
  return {
    ...node,
    first: node.first.kind === "split" ? patchSplit(node.first, splitId, patch) : node.first,
    second: node.second.kind === "split" ? patchSplit(node.second, splitId, patch) : node.second
  };
}

export function resizeDomSplit(state: DomProLayoutState, region: "root" | "upper" | "bottom", splitId: string, deltaWithinSplit: number): DomProLayoutState {
  const key = region === "root" ? "rootSplit" : region === "upper" ? "upperSplit" : "bottomSplit";
  const tree = state[key];
  const nextTree = patchSplit(tree, splitId, (split) => ({ ...split, ratio: clamp(split.ratio + deltaWithinSplit, split.minRatio, split.maxRatio) }));
  return { ...state, [key]: nextTree, preset: state.preset, updatedAt: Date.now() };
}

export function splitSpanRatio(root: DomSplitNode, splitId: string): number {
  function visit(node: DomSplitNode | DomPanelLayoutNode, span: number): number | null {
    if (node.kind === "panel") return null;
    if (node.id === splitId) return span;
    return visit(node.first, span * node.ratio) ?? visit(node.second, span * (1 - node.ratio));
  }
  return visit(root, 1) ?? 1;
}

export function domLeafWeights(root: DomSplitNode): Array<{ panelId: DomWorkspacePanelId; weight: number }> {
  const leaves: Array<{ panelId: DomWorkspacePanelId; weight: number }> = [];
  function visit(node: DomSplitNode | DomPanelLayoutNode, weight: number) {
    if (node.kind === "panel") {
      leaves.push({ panelId: node.panelId, weight });
      return;
    }
    visit(node.first, weight * node.ratio);
    visit(node.second, weight * (1 - node.ratio));
  }
  visit(root, 1);
  return leaves;
}

export function domSeparatorPositions(root: DomSplitNode) {
  const leaves = domLeafWeights(root);
  let cumulative = 0;
  return leaves.slice(0, -1).map((leaf, index) => {
    cumulative += leaf.weight;
    return { splitId: splitIdsInVisualOrder(root)[index], position: cumulative };
  });
}

export function domWorkspaceTracks(root: DomSplitNode, panelStates: Record<DomWorkspacePanelId, DomPanelLayoutState>) {
  const leaves = domLeafWeights(root);
  const weighted = leaves.map((leaf) => ({ ...leaf, weight: panelStates[leaf.panelId]?.collapsed ? 0.025 : leaf.weight }));
  const total = weighted.reduce((sum, leaf) => sum + leaf.weight, 0) || 1;
  const normalized = weighted.map((leaf) => ({ ...leaf, weight: leaf.weight / total }));
  const splitIds = splitIdsInVisualOrder(root);
  let cumulative = 0;
  return {
    columns: normalized.map((leaf) => `${Math.max(0.001, leaf.weight)}fr`).join(" "),
    separators: normalized.slice(0, -1).map((leaf, index) => {
      cumulative += leaf.weight;
      return { splitId: splitIds[index], position: cumulative };
    })
  };
}

function splitIdsInVisualOrder(root: DomSplitNode) {
  const ids: string[] = [];
  let node: DomSplitNode | DomPanelLayoutNode = root;
  while (node.kind === "split") {
    ids.push(node.id);
    node = node.second;
  }
  return ids;
}

export function patchDomPanelLayout(state: DomProLayoutState, panelId: DomWorkspacePanelId, patch: Partial<DomPanelLayoutState>): DomProLayoutState {
  return {
    ...state,
    panelStates: { ...state.panelStates, [panelId]: { ...state.panelStates[panelId], ...patch } },
    updatedAt: Date.now()
  };
}

export function maximizeDomPanel(state: DomProLayoutState, panelId: DomWorkspacePanelId | null): DomProLayoutState {
  return { ...state, maximizedPanel: panelId, updatedAt: Date.now() };
}

export function domLayoutStorageKey(workspaceId: string, windowId = "primary") {
  return `bt:dom-pro-layout:v${DOM_PRO_LAYOUT_VERSION}:${workspaceId}:${windowId}`;
}

export function readDomProLayout(workspaceId: string, windowId = "primary", storage: LayoutStorage | null = browserStorage()): DomProLayoutState {
  if (!storage) return createDomProLayout(workspaceId);
  try {
    const parsed = JSON.parse(storage.getItem(domLayoutStorageKey(workspaceId, windowId)) || "null") as Partial<DomProLayoutState> | null;
    if (!parsed || parsed.version !== DOM_PRO_LAYOUT_VERSION || parsed.workspaceId !== workspaceId || !parsed.rootSplit || !parsed.upperSplit || !parsed.bottomSplit) return createDomProLayout(workspaceId);
    const defaults = createDomProLayout(workspaceId, parsed.preset ?? "institutional");
    return {
      ...defaults,
      ...parsed,
      panelStates: { ...defaults.panelStates, ...(parsed.panelStates ?? {}) },
      maximizedPanel: null
    } as DomProLayoutState;
  } catch {
    return createDomProLayout(workspaceId);
  }
}

export function writeDomProLayout(state: DomProLayoutState, windowId = "primary", storage: LayoutStorage | null = browserStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(domLayoutStorageKey(state.workspaceId, windowId), JSON.stringify({ ...state, maximizedPanel: null, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function saveDomProLayoutPreset(state: DomProLayoutState, name: string, storage: LayoutStorage | null = browserStorage()) {
  if (!storage) return false;
  const normalized = name.trim().slice(0, 48);
  if (!normalized) return false;
  try {
    storage.setItem(`bt:dom-pro-layout-preset:${state.workspaceId}:${normalized}`, JSON.stringify({ ...state, maximizedPanel: null, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function listDomProLayoutPresets(workspaceId: string, storage: LayoutStorage | null = browserStorage()) {
  if (!storage) return [];
  const prefix = `bt:dom-pro-layout-preset:${workspaceId}:`;
  const names: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) names.push(key.slice(prefix.length));
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export function readDomProLayoutPreset(workspaceId: string, name: string, storage: LayoutStorage | null = browserStorage()): DomProLayoutState | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(`bt:dom-pro-layout-preset:${workspaceId}:${name}`) || "null") as DomProLayoutState | null;
    if (!parsed || parsed.version !== DOM_PRO_LAYOUT_VERSION || parsed.workspaceId !== workspaceId) return null;
    return { ...parsed, maximizedPanel: null, updatedAt: Date.now() };
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
