type TraceSample = { durationMs: number; inputSize: number; outputSize: number; time: number };

const sampleLimit = 600;

class DomPerformanceTrace {
  private startedAt = Date.now();
  private spans = new Map<string, TraceSample[]>();
  private counters = new Map<string, number>();

  record(name: string, durationMs: number, inputSize = 0, outputSize = 0) {
    if (!Number.isFinite(durationMs)) return;
    const samples = this.spans.get(name) ?? [];
    samples.push({ durationMs, inputSize, outputSize, time: Date.now() });
    if (samples.length > sampleLimit) samples.splice(0, samples.length - sampleLimit);
    this.spans.set(name, samples);
  }

  increment(name: string, amount = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  setCounter(name: string, value: number) {
    this.counters.set(name, value);
  }

  reset() {
    this.startedAt = Date.now();
    this.spans.clear();
    this.counters.clear();
  }

  snapshot() {
    const now = Date.now();
    const spans = Object.fromEntries([...this.spans.entries()].map(([name, values]) => {
      const recent = values.filter((value) => now - value.time <= 60_000);
      const durations = values.map((value) => value.durationMs).sort((a, b) => a - b);
      return [name, {
        calls: values.length,
        callsPerSecond: recent.length / 60,
        averageMs: average(durations),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
        maxMs: durations.at(-1) ?? 0,
        averageInputSize: average(values.map((value) => value.inputSize)),
        averageOutputSize: average(values.map((value) => value.outputSize))
      }];
    }));
    return { startedAt: this.startedAt, generatedAt: now, spans, counters: Object.fromEntries(this.counters) };
  }
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], pct: number) {
  return values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * pct) - 1))] : 0;
}

export const domPerformanceTrace = new DomPerformanceTrace();

if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("domPerfTrace")) {
  (window as Window & { __DOM_PRO_PERFORMANCE__?: { snapshot: () => ReturnType<DomPerformanceTrace["snapshot"]>; reset: () => void } }).__DOM_PRO_PERFORMANCE__ = {
    snapshot: () => domPerformanceTrace.snapshot(),
    reset: () => domPerformanceTrace.reset()
  };
}
