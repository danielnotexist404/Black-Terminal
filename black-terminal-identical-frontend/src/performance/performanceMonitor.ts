import { blackCoreEventBus } from "../core/blackCore";

export class PerformanceMonitor {
  private frameTimes: number[] = [];

  recordMetric(name: string, value: number, unit: string, tags?: Record<string, string>) {
    blackCoreEventBus.publish("performance.metric", { name, value, unit, tags, time: Date.now() });
  }

  recordFrame(renderMs: number) {
    this.frameTimes.push(renderMs);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    this.recordMetric("render.frame_ms", renderMs, "ms");
  }

  fps() {
    if (this.frameTimes.length === 0) return 0;
    const avg = this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length;
    return avg > 0 ? 1000 / avg : 0;
  }
}
