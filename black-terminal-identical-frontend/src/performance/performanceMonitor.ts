import { blackCoreEventBus } from "../core/blackCore";
import { blackCoreWorkloadScheduler } from "../core/scheduling/workloadScheduler";
import { blackCoreResourceTracker, type ResourceSnapshot } from "./resourceTracker";

export type MetricSample = {
  name: string;
  value: number;
  unit: string;
  time: number;
  tags?: Record<string, string>;
};

export type PerformanceMark = { label: string; time: number };

export type PerformanceSnapshot = {
  generatedAt: number;
  uptimeMs: number;
  status: "stable" | "watch" | "degraded";
  fps: number;
  chartFps: number;
  immFps: number;
  averageFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  worstFrameMs: number;
  droppedFrames: number;
  longTaskCount: number;
  longTaskOver100Count: number;
  longestTaskMs: number;
  heapUsedMb: number | null;
  heapTotalMb: number | null;
  heapLimitMb: number | null;
  heapGrowthMb: number | null;
  domNodes: number | null;
  eventBusEventsPerSecond: number;
  publicMessagesPerSecond: number;
  privateMessagesPerSecond: number;
  workerQueueDepth: number;
  renderQueueDepth: number;
  resources: ResourceSnapshot;
  latestMetrics: MetricSample[];
  eventBus: ReturnType<typeof blackCoreEventBus.diagnostics>;
  marks: PerformanceMark[];
};

type PerformanceListener = (snapshot: PerformanceSnapshot) => void;
type Capture = { startedAt: number; samples: PerformanceSnapshot[]; marks: PerformanceMark[] };

const maxFrameSamples = 1800;
const maxLongTasks = 600;
const maxCaptureSamples = 7200;

export class PerformanceMonitor {
  private startedAt = Date.now();
  private frameTimes: number[] = [];
  private surfaceFrames = new Map<string, number[]>();
  private latestMetrics = new Map<string, MetricSample>();
  private lastMetricPublishAt = new Map<string, number>();
  private listeners = new Set<PerformanceListener>();
  private animationFrameId: number | null = null;
  private sampleTimer: number | null = null;
  private observer: PerformanceObserver | null = null;
  private releaseAnimationFrame: (() => void) | null = null;
  private releaseSampleTimer: (() => void) | null = null;
  private lastFrameAt = 0;
  private lastMetricFrameAt = 0;
  private droppedFrames = 0;
  private longTasks: number[] = [];
  private lastLongTaskAt = 0;
  private lastSevereLongTaskAt = 0;
  private running = false;
  private heapBaselineMb: number | null = null;
  private lastPublishCount = 0;
  private lastRateSampleAt = Date.now();
  private eventBusEventsPerSecond = 0;
  private capture: Capture | null = null;
  private marks: PerformanceMark[] = [];

  start() {
    if (this.running || typeof window === "undefined") return;
    this.running = true;
    this.startedAt = Date.now();
    this.lastRateSampleAt = Date.now();
    this.lastPublishCount = blackCoreEventBus.diagnostics().totalPublishes;
    this.lastFrameAt = performance.now();
    this.heapBaselineMb = readBrowserMemory()?.usedMb ?? null;
    this.installLongTaskObserver();
    this.releaseAnimationFrame = blackCoreResourceTracker.acquire("animation-frame", "performance-monitor");
    this.animationFrameId = window.requestAnimationFrame(this.sampleFrame);
    this.releaseSampleTimer = blackCoreResourceTracker.acquire("interval", "performance-monitor");
    this.sampleTimer = window.setInterval(() => this.emitSnapshot(), 1000);
  }

  stop() {
    if (typeof window === "undefined") return;
    if (this.animationFrameId !== null) window.cancelAnimationFrame(this.animationFrameId);
    if (this.sampleTimer !== null) window.clearInterval(this.sampleTimer);
    this.observer?.disconnect();
    this.releaseAnimationFrame?.();
    this.releaseSampleTimer?.();
    this.animationFrameId = null;
    this.sampleTimer = null;
    this.observer = null;
    this.releaseAnimationFrame = null;
    this.releaseSampleTimer = null;
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
    if (!Number.isFinite(value)) return;
    const sample = { name, value, unit, tags, time: Date.now() };
    const key = metricKey(name, tags);
    this.latestMetrics.set(key, sample);
    const lastPublishedAt = this.lastMetricPublishAt.get(key) ?? 0;
    if (sample.time - lastPublishedAt >= 1000) {
      this.lastMetricPublishAt.set(key, sample.time);
      blackCoreEventBus.publish("performance.metric", sample);
    }
  }

  recordFrame(frameMs: number, tags?: Record<string, string>) {
    const surface = tags?.surface ?? "unknown";
    const frames = this.surfaceFrames.get(surface) ?? [];
    pushBounded(frames, frameMs, 600);
    this.surfaceFrames.set(surface, frames);
    const now = performance.now();
    if (now - this.lastMetricFrameAt >= 1000) {
      this.lastMetricFrameAt = now;
      this.recordMetric("render.frame_ms", frameMs, "ms", tags);
      this.recordMetric("render.fps", fpsFromFrames(frames), "fps", tags);
    }
  }

  startSpan(name: string, tags?: Record<string, string>) {
    const startedAt = performance.now();
    let finished = false;
    return () => {
      if (finished) return 0;
      finished = true;
      const duration = performance.now() - startedAt;
      this.recordMetric(name, duration, "ms", tags);
      return duration;
    };
  }

  startCapture() {
    this.start();
    this.capture = { startedAt: Date.now(), samples: [], marks: [] };
  }

  stopCapture() {
    const capture = this.capture;
    this.capture = null;
    return capture;
  }

  isCapturing() {
    return Boolean(this.capture);
  }

  mark(label = "MARK") {
    const mark = { label: label.slice(0, 80), time: Date.now() };
    this.marks = [...this.marks, mark].slice(-40);
    if (this.capture) this.capture.marks.push(mark);
    return mark;
  }

  resetCounters() {
    this.frameTimes = [];
    this.surfaceFrames.clear();
    this.latestMetrics.clear();
    this.lastMetricPublishAt.clear();
    this.longTasks = [];
    this.lastLongTaskAt = 0;
    this.lastSevereLongTaskAt = 0;
    this.droppedFrames = 0;
    this.startedAt = Date.now();
    this.heapBaselineMb = readBrowserMemory()?.usedMb ?? null;
    this.marks = [];
    blackCoreResourceTracker.resetCounters();
    blackCoreWorkloadScheduler.resetCounters();
  }

  sessionReport() {
    return {
      exportedAt: new Date().toISOString(),
      capture: this.capture,
      current: this.snapshot()
    };
  }

  snapshot(): PerformanceSnapshot {
    const frames = [...this.frameTimes].sort((a, b) => a - b);
    const memory = readBrowserMemory();
    const eventBus = blackCoreEventBus.diagnostics();
    const resources = blackCoreResourceTracker.snapshot();
    const scheduler = blackCoreWorkloadScheduler.diagnostics();
    const chartFps = this.surfaceFps("pixi-chart");
    const immFps = this.surfaceFps("dom-pro");
    const p95 = percentile(frames, 0.95);
    const p99 = percentile(frames, 0.99);
    const heapGrowthMb = memory?.usedMb !== undefined && this.heapBaselineMb !== null ? memory.usedMb - this.heapBaselineMb : null;
    const now = Date.now();
    const recentLongTask = now - this.lastLongTaskAt < 60_000;
    const recentSevereLongTask = now - this.lastSevereLongTaskAt < 60_000;
    const status = p99 > 80 || recentSevereLongTask || (heapGrowthMb ?? 0) > 256
      ? "degraded"
      : p95 > 32 || recentLongTask || (heapGrowthMb ?? 0) > 128
        ? "watch"
        : "stable";
    return {
      generatedAt: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      status,
      fps: fpsFromFrames(this.frameTimes),
      chartFps,
      immFps,
      averageFrameMs: average(this.frameTimes),
      p50FrameMs: percentile(frames, 0.5),
      p95FrameMs: p95,
      p99FrameMs: p99,
      worstFrameMs: frames[frames.length - 1] ?? 0,
      droppedFrames: this.droppedFrames,
      longTaskCount: this.longTasks.length,
      longTaskOver100Count: this.longTasks.filter((duration) => duration >= 100).length,
      longestTaskMs: Math.max(0, ...this.longTasks),
      heapUsedMb: memory?.usedMb ?? null,
      heapTotalMb: memory?.totalMb ?? null,
      heapLimitMb: memory?.limitMb ?? null,
      heapGrowthMb,
      domNodes: typeof document === "undefined" ? null : document.getElementsByTagName("*").length,
      eventBusEventsPerSecond: this.eventBusEventsPerSecond,
      publicMessagesPerSecond: this.metricValue("stream.public_messages_per_second"),
      privateMessagesPerSecond: this.metricValue("stream.private_messages_per_second"),
      workerQueueDepth: resources.active["worker-queue"] ?? 0,
      renderQueueDepth: scheduler.queueDepth,
      resources,
      latestMetrics: [...this.latestMetrics.values()].sort((a, b) => b.time - a.time).slice(0, 40),
      eventBus,
      marks: [...this.marks]
    };
  }

  private sampleFrame = (time: number) => {
    if (!this.running || typeof window === "undefined") return;
    const delta = time - this.lastFrameAt;
    this.lastFrameAt = time;
    if (document.visibilityState === "visible") {
      pushBounded(this.frameTimes, delta, maxFrameSamples);
      if (delta > 50) this.droppedFrames += Math.max(1, Math.floor(delta / 16.67) - 1);
    }
    this.animationFrameId = window.requestAnimationFrame(this.sampleFrame);
  };

  private emitSnapshot() {
    const now = Date.now();
    const eventBus = blackCoreEventBus.diagnostics();
    const elapsedSeconds = Math.max(0.001, (now - this.lastRateSampleAt) / 1000);
    this.eventBusEventsPerSecond = Math.max(0, eventBus.totalPublishes - this.lastPublishCount) / elapsedSeconds;
    this.lastPublishCount = eventBus.totalPublishes;
    this.lastRateSampleAt = now;
    const snapshot = this.snapshot();
    if (this.capture) pushBounded(this.capture.samples, snapshot, maxCaptureSamples);
    for (const listener of this.listeners) listener(snapshot);
  }

  private installLongTaskObserver() {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 50) continue;
          pushBounded(this.longTasks, entry.duration, maxLongTasks);
          this.lastLongTaskAt = Date.now();
          if (entry.duration >= 100) this.lastSevereLongTaskAt = this.lastLongTaskAt;
          this.recordMetric("browser.long_task_ms", entry.duration, "ms");
        }
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer = null;
    }
  }

  private surfaceFps(surface: string) {
    const explicit = [...this.latestMetrics.values()].find((sample) => sample.name === "render.fps" && sample.tags?.surface === surface);
    return explicit?.value ?? fpsFromFrames(this.surfaceFrames.get(surface) ?? []);
  }

  private metricValue(name: string) {
    let value = 0;
    for (const metric of this.latestMetrics.values()) if (metric.name === name) value += metric.value;
    return value;
  }
}

function metricKey(name: string, tags?: Record<string, string>) {
  return tags ? `${name}:${Object.entries(tags).sort().map(([key, value]) => `${key}=${value}`).join(",")}` : name;
}

function pushBounded<T>(values: T[], value: T, limit: number) {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(sortedValues: number[], pct: number) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * pct) - 1));
  return sortedValues[index];
}

function fpsFromFrames(frames: number[]) {
  const avg = average(frames);
  return avg > 0 ? 1000 / avg : 0;
}

function readBrowserMemory() {
  if (typeof performance === "undefined") return null;
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!memory) return null;
  return {
    usedMb: memory.usedJSHeapSize / 1024 / 1024,
    totalMb: memory.totalJSHeapSize / 1024 / 1024,
    limitMb: memory.jsHeapSizeLimit / 1024 / 1024
  };
}

export const blackCorePerformanceMonitor = new PerformanceMonitor();
