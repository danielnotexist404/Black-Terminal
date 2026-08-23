import type { ChartPriceTransformSnapshot } from "../../chart-engine/priceTransform";

type ViewportListener = () => void;

export class ChartPriceViewportStore {
  private snapshots = new Map<string, ChartPriceTransformSnapshot>();
  private listeners = new Map<string, Set<ViewportListener>>();

  publish(key: string, snapshot: ChartPriceTransformSnapshot) {
    if (!key) return;
    const current = this.snapshots.get(key);
    if (current?.revision === snapshot.revision) return;
    this.snapshots.set(key, snapshot);
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  getSnapshot(key: string) {
    return this.snapshots.get(key) ?? null;
  }

  subscribe(key: string, listener: ViewportListener) {
    const listeners = this.listeners.get(key) ?? new Set<ViewportListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  clear(key: string) {
    if (!this.snapshots.delete(key)) return;
    this.listeners.get(key)?.forEach((listener) => listener());
  }
}

export const blackCoreChartPriceViewportStore = new ChartPriceViewportStore();
