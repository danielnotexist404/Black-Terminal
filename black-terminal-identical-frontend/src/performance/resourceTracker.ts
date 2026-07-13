export type RuntimeResourceKind =
  | "interval"
  | "timeout"
  | "animation-frame"
  | "listener"
  | "observer"
  | "worker"
  | "websocket"
  | "supabase-subscription"
  | "pixi-container"
  | "pixi-graphics"
  | "pixi-text"
  | "pixi-texture"
  | "pixi-geometry"
  | "render-queue"
  | "worker-queue";

export type ResourceSnapshot = {
  active: Record<string, number>;
  created: Record<string, number>;
  highWater: Record<string, number>;
  byOwner: Record<string, number>;
  totalActive: number;
};

type ResourceRecord = {
  id: number;
  kind: RuntimeResourceKind;
  owner: string;
  createdAt: number;
};

class RuntimeResourceTracker {
  private nextId = 1;
  private resources = new Map<number, ResourceRecord>();
  private created = new Map<RuntimeResourceKind, number>();
  private highWater = new Map<RuntimeResourceKind, number>();
  private gauges = new Map<string, { kind: RuntimeResourceKind; owner: string; value: number }>();

  acquire(kind: RuntimeResourceKind, owner: string) {
    const id = this.nextId++;
    this.resources.set(id, { id, kind, owner, createdAt: Date.now() });
    this.created.set(kind, (this.created.get(kind) ?? 0) + 1);
    this.highWater.set(kind, Math.max(this.highWater.get(kind) ?? 0, this.activeCount(kind)));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.resources.delete(id);
    };
  }

  setGauge(kind: RuntimeResourceKind, owner: string, value: number) {
    this.gauges.set(`${kind}:${owner}`, { kind, owner, value: Math.max(0, Math.floor(value)) });
    this.highWater.set(kind, Math.max(this.highWater.get(kind) ?? 0, this.activeCount(kind)));
  }

  clearGauge(kind: RuntimeResourceKind, owner: string) {
    this.gauges.delete(`${kind}:${owner}`);
  }

  snapshot(): ResourceSnapshot {
    const active: Record<string, number> = {};
    const byOwner: Record<string, number> = {};
    for (const resource of this.resources.values()) {
      active[resource.kind] = (active[resource.kind] ?? 0) + 1;
      byOwner[resource.owner] = (byOwner[resource.owner] ?? 0) + 1;
    }
    for (const gauge of this.gauges.values()) {
      active[gauge.kind] = (active[gauge.kind] ?? 0) + gauge.value;
      byOwner[gauge.owner] = (byOwner[gauge.owner] ?? 0) + gauge.value;
    }
    return {
      active,
      created: Object.fromEntries(this.created),
      highWater: Object.fromEntries(this.highWater),
      byOwner,
      totalActive: Object.values(active).reduce((sum, value) => sum + value, 0)
    };
  }

  resetCounters() {
    this.created.clear();
    this.highWater.clear();
    for (const kind of new Set([...this.resources.values()].map((resource) => resource.kind))) {
      this.highWater.set(kind, this.activeCount(kind));
    }
  }

  private activeCount(kind: RuntimeResourceKind) {
    let count = 0;
    for (const resource of this.resources.values()) if (resource.kind === kind) count += 1;
    for (const gauge of this.gauges.values()) if (gauge.kind === kind) count += gauge.value;
    return count;
  }
}

export const blackCoreResourceTracker = new RuntimeResourceTracker();
