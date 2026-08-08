type MetricType = "counter" | "gauge" | "histogram";

interface Metric {
  name: string;
  help: string;
  type: MetricType;
  value: number;
  samples: number[];
}

export class BclifMetricRegistry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string, delta = 1) {
    const metric = this.ensure(name, help, "counter");
    metric.value += Math.max(0, delta);
  }

  gauge(name: string, help: string, value: number) {
    const metric = this.ensure(name, help, "gauge");
    metric.value = Number.isFinite(value) ? value : 0;
  }

  observe(name: string, help: string, value: number) {
    if (!Number.isFinite(value)) return;
    const metric = this.ensure(name, help, "histogram");
    metric.samples.push(value);
    if (metric.samples.length > 4_096) metric.samples.splice(0, metric.samples.length - 4_096);
    metric.value = value;
  }

  snapshot() {
    const result: Record<string, unknown> = {};
    for (const metric of this.metrics.values()) {
      result[metric.name] = metric.type === "histogram"
        ? { latest: metric.value, count: metric.samples.length, ...percentiles(metric.samples) }
        : metric.value;
    }
    return result;
  }

  prometheus() {
    const lines: string[] = [];
    for (const metric of [...this.metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type === "histogram" ? "gauge" : metric.type}`);
      if (metric.type === "histogram") {
        const values = percentiles(metric.samples);
        lines.push(`${metric.name}{quantile="0.50"} ${values.p50}`, `${metric.name}{quantile="0.95"} ${values.p95}`, `${metric.name}{quantile="0.99"} ${values.p99}`);
      } else {
        lines.push(`${metric.name} ${metric.value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private ensure(name: string, help: string, type: MetricType) {
    if (!/^bclif_[a-z0-9_]+$/.test(name)) throw new Error(`Invalid BCLIF metric name ${name}`);
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== type) throw new Error(`Metric type mismatch for ${name}`);
      return existing;
    }
    const created: Metric = { name, help, type, value: 0, samples: [] };
    this.metrics.set(name, created);
    return created;
  }
}

function percentiles(source: number[]) {
  if (!source.length) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...source].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}
