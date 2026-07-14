import type { DomPanelId } from "./domPanelSettingsStore";

type PanelSchedule = {
  calculationMs: number;
  renderMs: number;
  lastCalculationAt: number;
  lastRenderAt: number;
  calculations: number;
  renders: number;
  coalesced: number;
  suspended: boolean;
  immediate: boolean;
};

export type DomPanelSchedulerMetrics = PanelSchedule & { panelId: DomPanelId };

export class DomPanelUpdateScheduler {
  private panels = new Map<DomPanelId, PanelSchedule>();

  registerPanel(panelId: DomPanelId, calculationMs: number, renderMs = calculationMs) {
    const existing = this.panels.get(panelId);
    this.panels.set(panelId, {
      calculationMs: boundedCadence(panelId, calculationMs),
      renderMs: boundedCadence(panelId, renderMs),
      lastCalculationAt: existing?.lastCalculationAt ?? 0,
      lastRenderAt: existing?.lastRenderAt ?? 0,
      calculations: existing?.calculations ?? 0,
      renders: existing?.renders ?? 0,
      coalesced: existing?.coalesced ?? 0,
      suspended: existing?.suspended ?? false,
      immediate: existing?.immediate ?? true
    });
  }

  setCadence(panelId: DomPanelId, calculationMs: number, renderMs = calculationMs) {
    this.registerPanel(panelId, calculationMs, renderMs);
  }

  suspendPanel(panelId: DomPanelId) {
    const panel = this.panels.get(panelId);
    if (panel) panel.suspended = true;
  }

  resumePanel(panelId: DomPanelId) {
    const panel = this.panels.get(panelId);
    if (panel) {
      panel.suspended = false;
      panel.immediate = true;
    }
  }

  requestImmediateUpdate(panelId: DomPanelId) {
    const panel = this.panels.get(panelId);
    if (panel) panel.immediate = true;
  }

  shouldCalculate(panelId: DomPanelId, now = performanceNow()) {
    const panel = this.panels.get(panelId);
    if (!panel || panel.suspended) return false;
    if (!panel.immediate && now - panel.lastCalculationAt < panel.calculationMs) {
      panel.coalesced += 1;
      return false;
    }
    panel.immediate = false;
    panel.lastCalculationAt = now;
    panel.calculations += 1;
    return true;
  }

  shouldRender(panelId: DomPanelId, now = performanceNow()) {
    const panel = this.panels.get(panelId);
    if (!panel || panel.suspended || now - panel.lastRenderAt < panel.renderMs) return false;
    panel.lastRenderAt = now;
    panel.renders += 1;
    return true;
  }

  coalesceUpdates(panelId: DomPanelId, now = performanceNow()) {
    return this.shouldCalculate(panelId, now) && this.shouldRender(panelId, now);
  }

  reportMetrics(panelId?: DomPanelId): DomPanelSchedulerMetrics[] {
    return [...this.panels.entries()]
      .filter(([id]) => !panelId || panelId === id)
      .map(([id, schedule]) => ({ panelId: id, ...schedule }));
  }
}

function boundedCadence(panelId: DomPanelId, value: number) {
  const safeMinimums: Record<DomPanelId, number> = {
    ladder: 50,
    "volume-profile": 500,
    "liquidity-heatmap": 100,
    "wall-detection": 500,
    "trade-tape": 100,
    "dom-metrics": 250,
    "heuristic-cvd": 250,
    "depth-chart": 250,
    "liquidity-flow-delta": 250,
    execution: 250
  };
  return Math.max(safeMinimums[panelId], Math.min(60_000, Number.isFinite(value) ? value : 1000));
}

function performanceNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
