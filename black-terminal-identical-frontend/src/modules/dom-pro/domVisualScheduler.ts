import { blackCorePerformanceMonitor } from "../../performance/performanceMonitor";
import { blackCoreResourceTracker } from "../../performance/resourceTracker";
import { domPerformanceTrace } from "./domPerformanceTrace";

type DrawCallback = (time: number, budgetMs: number) => void;
type VisualEntry = { draw: DrawCallback; dirty: boolean; visible: boolean; priority: number };

class DomVisualScheduler {
  private entries = new Map<string, VisualEntry>();
  private frame: number | null = null;
  private releaseFrame: (() => void) | null = null;

  register(id: string, draw: DrawCallback, priority = 3) {
    this.entries.set(id, { draw, dirty: true, visible: true, priority });
    this.requestFrame();
    return () => {
      this.entries.delete(id);
      if (!this.entries.size && this.frame !== null) this.cancelFrame();
    };
  }

  markDirty(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.dirty = true;
    this.requestFrame();
  }

  markAllDirty() {
    for (const entry of this.entries.values()) entry.dirty = true;
    this.requestFrame();
  }

  setVisible(id: string, visible: boolean) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.visible = visible;
    if (visible) {
      entry.dirty = true;
      this.requestFrame();
    }
  }

  scheduleOnce(id: string, draw: DrawCallback, priority = 2) {
    const existing = this.entries.get(id);
    if (existing) {
      existing.draw = draw;
      existing.priority = priority;
      existing.dirty = true;
      this.requestFrame();
      return;
    }
    this.entries.set(id, {
      priority,
      dirty: true,
      visible: true,
      draw: (time, budgetMs) => {
        this.entries.delete(id);
        draw(time, budgetMs);
      }
    });
    this.requestFrame();
  }

  private requestFrame() {
    if (this.frame !== null || typeof window === "undefined" || document.visibilityState === "hidden") return;
    this.releaseFrame = blackCoreResourceTracker.acquire("animation-frame", "dom-pro-master-visual");
    this.frame = window.requestAnimationFrame((time) => this.draw(time));
  }

  private draw(time: number) {
    this.frame = null;
    this.releaseFrame?.();
    this.releaseFrame = null;
    const startedAt = performance.now();
    const frameBudgetMs = 7;
    const dirty = [...this.entries.entries()]
      .filter(([, entry]) => entry.dirty && entry.visible)
      .sort((a, b) => a[1].priority - b[1].priority);
    for (const [, entry] of dirty) {
      if (performance.now() - startedAt >= frameBudgetMs) break;
      entry.dirty = false;
      entry.draw(time, Math.max(1, frameBudgetMs - (performance.now() - startedAt)));
    }
    const frameMs = performance.now() - startedAt;
    domPerformanceTrace.record("canvas.master_frame", frameMs, dirty.length, dirty.filter(([, entry]) => !entry.dirty).length);
    blackCorePerformanceMonitor.recordFrame(frameMs, { surface: "dom-pro-canvas" });
    if ([...this.entries.values()].some((entry) => entry.dirty && entry.visible)) this.requestFrame();
  }

  private cancelFrame() {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.releaseFrame?.();
    this.releaseFrame = null;
  }
}

export const domVisualScheduler = new DomVisualScheduler();
