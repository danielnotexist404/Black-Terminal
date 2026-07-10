import { blackCoreEventBus } from "../core/blackCore";

type MetricSample = {
  name: string;
  value: number;
  unit: string;
  time: number;
  tags?: Record<string, string>;
};

export type PerformanceSnapshot = {
  generatedAt: number;
  uptimeMs: number;
  fps: number;
  averageFrameMs: number;
  p99FrameMs: number;
  worstFrameMs: number;
  droppedFrames: number;
  longTaskCount: number;
  longestTaskMs: number;
  heapUsedMb: number | null;
  heapLimitMb: number | null;
  domNodes: number | null;
  latestMetrics: MetricSample[];
  eventBus: ReturnType<typeof blackCoreEventBus.diagnostics>;
};

type PerformanceListener = (snapshot: PerformanceSnapshot) => void;

export class PerformanceMonitor {
  private startedAt = Date.now();
  private frameTimes: number[] = [];
  private latestMetrics = new Map<string, MetricSample>();
  private lastMetricPublishAt = new Map<string, number>();
  private listeners = new Set<PerformanceListener>();
  private animationFrameId: number | null = null;
  private sampleTimer: number | null = null;
  private observer: PerformanceObserver | null = null;
  private lastFrameAt = 0;
  private lastFrameMetricAt = 0;
  private droppedFrames = 0;
  private longTasks: number[] = [];
  private running = false;

  start() {
    if (this.running || typeof window === "undefined") return;
    this.running = true;
    this.startedAt = Date.now();
    this.lastFrameAt = performance.now();
    this.installLongTaskObserver();
    this.animationFrameId = window.requestAnimationFrame(this.sampleFrame);
    this.sampleTimer = window.setInterval(() => this.emitSnapshot(), 1000);
  }

  stop() {
    if (typeof window === "undefined") return;
    if (this.animationFrameId !== null) window.cancelAnimationFrame(this.animationFrameId);
    if (this.sampleTimer !== null) window.clearInterval(this.sampleTimer);
    this.observer?.disconnect();
    this.animationFrameId = null;
    this.sampleTimer = null;
    this.observer = null;
    this.running = false;
  }

  subscribe(listener: PerformanceListener) {
    this.start();
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  recordMetric(name: string, value: number, unit: string, tags?: Record<string, string>) {
    const sample = { name, value, unit, tags, time: Date.now() };
    const key = metricKey(name, tags);
    this.latestMetrics.set(key, sample);
    const lastPublishedAt = this.lastMetricPublishAt.get(key) ?? 0;
    if (sample.time - lastPublishedAt >= 500) {
      this.lastMetricPublishAt.set(key, sample.time);
      blackCoreEventBus.publish("performance.metric", sample);
    }
  }

  recordFrame(renderMs: number, tags?: Record<string, string>) {
    this.pushFrame(renderMs);
    const now = performance.now();
    if (now - this.lastFrameMetricAt >= 1000) {
      this.lastFrameMetricAt = now;
      this.recordMetric("render.frame_ms", renderMs, "ms", tags);
      this.recordMetric("render.fps", this.fps(), "fps", tags);
    }
  }

  recordLongTask(durationMs: number) {
    this.longTasks.push(durationMs);
    if (this.longTasks.length > 600) this.longTasks.shift();
    this.recordMetric("browser.long_task_ms", durationMs, "ms");
  }

  fps() {
    if (this.frameTimes.length === 0) return 0;
    const avg = this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length;
    return avg > 0 ? 1000 / avg : 0;
  }

  snapshot(): PerformanceSnapshot {
    const frames = [...this.frameTimes].sort((a, b) => a - b);
    const memory = readBrowserMemory();
    return {
      generatedAt: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      fps: this.fps(),
      averageFrameMs: average(this.frameTimes),
      p99FrameMs: percentile(frames, 0.99),
      worstFrameMs: frames[frames.length - 1] ?? 0,
      droppedFrames: this.droppedFrames,
      longTaskCount: this.longTasks.length,
      longestTaskMs: Math.max(0, ...this.longTasks),
      heapUsedMb: memory?.usedMb ?? null,
      heapLimitMb: memory?.limitMb ?? null,
      domNodes: typeof document === "undefined" ? null : document.getElementsByTagName("*").length,
      latestMetrics: [...this.latestMetrics.values()].sort((a, b) => b.time - a.time).slice(0, 18),
      eventBus: blackCoreEventBus.diagnostics()
    };
  }

  private sampleFrame = (time: number) => {
    if (!this.running || typeof window === "undefined") return;
    const delta = time - this.lastFrameAt;
    this.lastFrameAt = time;
    this.pushFrame(delta);
    this.animationFrameId = window.requestAnimationFrame(this.sampleFrame);
  };

  private pushFrame(frameMs: number) {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return;
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 1800) this.frameTimes.shift();
    if (frameMs > 50) this.droppedFrames += 1;
  }

  private emitSnapshot() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private installLongTaskObserver() {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) this.recordLongTask(entry.duration);
        }
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer = null;
    }
  }
}

function metricKey(name: string, tags?: Record<string, string>) {
  return tags ? `${name}:${Object.entries(tags).sort().map(([key, value]) => `${key}=${value}`).join(",")}` : name;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: number[], pct: number) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * pct) - 1));
  return sortedValues[index];
}

function readBrowserMemory() {
  if (typeof performance === "undefined") return null;
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!memory) return null;
  return {
    usedMb: memory.usedJSHeapSize / 1024 / 1024,
    limitMb: memory.jsHeapSizeLimit / 1024 / 1024
  };
}

export const blackCorePerformanceMonitor = new PerformanceMonitor();
