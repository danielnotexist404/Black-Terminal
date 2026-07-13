import type { DomMetrics, WallDetection } from "./types";

export type DepthSampleLevel = { price: number; quantity: number };
export type StructuralDepthLevel = DepthSampleLevel & {
  averageSize: number;
  medianSize: number;
  persistencePct: number;
  observations: number;
  refillCount: number;
  cancellationRatio: number;
};

type DepthMemory = {
  samples: number[];
  observations: number;
  present: number;
  refillCount: number;
  cancellations: number;
  previousSize: number;
};

export class PersistentDepthProcessor {
  private memory = new Map<string, DepthMemory>();
  private samples = 0;

  ingest(bids: DepthSampleLevel[], asks: DepthSampleLevel[], maximumSamples = 40) {
    this.samples += 1;
    const seen = new Set<string>();
    for (const [side, levels] of [["bid", bids], ["ask", asks]] as const) {
      for (const level of levels) {
        if (!Number.isFinite(level.price) || !Number.isFinite(level.quantity) || level.quantity <= 0) continue;
        const key = `${side}:${level.price}`;
        seen.add(key);
        const record = this.memory.get(key) ?? { samples: [], observations: Math.max(0, this.samples - 1), present: 0, refillCount: 0, cancellations: 0, previousSize: 0 };
        record.observations += 1;
        record.present += 1;
        if (record.previousSize > 0 && level.quantity > record.previousSize * 1.15) record.refillCount += 1;
        if (record.previousSize > 0 && level.quantity < record.previousSize * 0.6) record.cancellations += 1;
        record.previousSize = level.quantity;
        record.samples.push(level.quantity);
        record.samples = record.samples.slice(-Math.max(1, maximumSamples));
        this.memory.set(key, record);
      }
    }
    for (const [key, record] of this.memory) {
      if (!seen.has(key)) {
        record.observations += 1;
        if (record.previousSize > 0) record.cancellations += 1;
        record.previousSize = 0;
      }
      if (record.observations > maximumSamples * 3 && record.present / record.observations < 0.08) this.memory.delete(key);
    }
  }

  structural(side: "bid" | "ask", persistenceThreshold = 55, minimumSize = 0): StructuralDepthLevel[] {
    const prefix = `${side}:`;
    return [...this.memory.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, record]) => {
      const sorted = record.samples.slice().sort((a, b) => a - b);
      const averageSize = record.samples.reduce((sum, value) => sum + value, 0) / Math.max(1, record.samples.length);
      const persistencePct = record.present / Math.max(1, record.observations) * 100;
      const cancellationRatio = record.cancellations / Math.max(1, record.observations);
      const ageFactor = Math.min(1, record.observations / 20);
      const refillFactor = 1 + Math.min(0.3, record.refillCount * 0.03);
      return {
        price: Number(key.slice(prefix.length)),
        quantity: averageSize * (persistencePct / 100) * (0.65 + ageFactor * 0.35) * refillFactor,
        averageSize,
        medianSize: sorted[Math.floor(sorted.length / 2)] ?? 0,
        persistencePct,
        observations: record.observations,
        refillCount: record.refillCount,
        cancellationRatio
      };
    }).filter((level) => level.persistencePct >= persistenceThreshold && level.quantity >= minimumSize);
  }

  reset() {
    this.memory.clear();
    this.samples = 0;
  }
}

type WallRecord = WallDetection & {
  observations: number;
  peakSize: number;
  lastSeenAt: number;
  reliability: number;
  lifecycle: string;
};

export class StableWallProcessor {
  private records = new Map<string, WallRecord>();
  private stableOrder: string[] = [];

  update(walls: WallDetection[], options: { activationScore: number; deactivationScore: number; minimumPersistenceMs: number; minimumObservations: number; maximumRows: number; sortMode: string; majorOnly: boolean }, now = Date.now()) {
    const seen = new Set<string>();
    for (const wall of walls) {
      seen.add(wall.id);
      const previous = this.records.get(wall.id);
      const observations = (previous?.observations ?? 0) + 1;
      const reliability = wall.score * 0.45 + wall.persistencePct * 0.35 + Math.min(20, observations * 2);
      const active = previous ? wall.score >= options.deactivationScore : wall.score >= options.activationScore;
      if (!active) continue;
      const lifecycle = !previous ? "appearing" : wall.size > previous.size * 1.12 ? "growing" : wall.size < previous.size * 0.72 ? "weakening" : "active";
      this.records.set(wall.id, { ...wall, observations, peakSize: Math.max(previous?.peakSize ?? 0, wall.size), lastSeenAt: now, reliability, lifecycle });
      if (!this.stableOrder.includes(wall.id)) this.stableOrder.push(wall.id);
    }
    for (const [id, record] of this.records) {
      if (seen.has(id)) continue;
      const elapsed = now - record.lastSeenAt;
      if (elapsed <= Math.max(10_000, options.minimumPersistenceMs * 2)) {
        this.records.set(id, { ...record, lifecycle: "pulled", score: record.score * 0.92 });
      } else {
        this.records.delete(id);
        this.stableOrder = this.stableOrder.filter((item) => item !== id);
      }
    }
    const eligible = [...this.records.values()].filter((wall) =>
      wall.persistenceMs >= options.minimumPersistenceMs &&
      wall.observations >= options.minimumObservations &&
      (!options.majorOnly || wall.reliability >= 75)
    );
    const ranked = eligible.slice().sort((a, b) => wallRank(b, options.sortMode) - wallRank(a, options.sortMode));
    const rank = new Map(ranked.map((wall, index) => [wall.id, index]));
    this.stableOrder.sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
    return this.stableOrder.map((id) => this.records.get(id)).filter((wall): wall is WallRecord => Boolean(wall) && eligible.some((item) => item.id === wall?.id)).slice(0, options.maximumRows);
  }
}

export type StabilizedMetrics = DomMetrics & { liquidityState: "STACKING" | "PULLING" | "BALANCED"; confidence: number; stateSince: number };

export class MetricsStabilizer {
  private value: DomMetrics | null = null;
  private state: StabilizedMetrics["liquidityState"] = "BALANCED";
  private candidate: StabilizedMetrics["liquidityState"] = "BALANCED";
  private candidateSince = 0;
  private stateSince = Date.now();

  update(raw: DomMetrics, smoothingLength: number, hysteresisPct: number, confirmationMs: number, now = Date.now()): StabilizedMetrics {
    const alpha = 2 / (Math.max(1, smoothingLength) + 1);
    this.value = this.value ? mapMetrics(raw, this.value, alpha) : { ...raw };
    const stacking = this.value.bidStacked + this.value.askStacked;
    const pulling = this.value.bidPulled + this.value.askPulled;
    const gap = (stacking - pulling) / Math.max(1, stacking + pulling) * 100;
    const next = gap > hysteresisPct ? "STACKING" : gap < -hysteresisPct ? "PULLING" : "BALANCED";
    if (next !== this.candidate) {
      this.candidate = next;
      this.candidateSince = now;
    }
    if (next !== this.state && now - this.candidateSince >= confirmationMs) {
      this.state = next;
      this.stateSince = now;
    }
    return { ...this.value, liquidityState: this.state, confidence: Math.min(100, Math.abs(gap)), stateSince: this.stateSince };
  }
}

export function aggregateTradeTape<T extends { tradeId: string; time: number; price: number; quantity: number; side: string }>(trades: T[], options: { minimumTradeSize: number; groupingIntervalMs: number; aggregateSamePrice: boolean; displayRows: number }): T[] {
  const source = trades.filter((trade) => trade.quantity >= options.minimumTradeSize);
  if (!options.aggregateSamePrice || options.groupingIntervalMs <= 0) return source.slice(0, options.displayRows);
  const grouped = new Map<string, T>();
  for (const trade of source) {
    const timeMs = trade.time > 100000000000 ? trade.time : trade.time * 1000;
    const key = `${trade.side}:${trade.price}:${Math.floor(timeMs / options.groupingIntervalMs)}`;
    const previous = grouped.get(key);
    grouped.set(key, previous ? { ...previous, quantity: previous.quantity + trade.quantity, tradeId: `${previous.tradeId}:group` } : { ...trade });
  }
  return [...grouped.values()].sort((a, b) => b.time - a.time).slice(0, options.displayRows);
}

export function clipAndSmoothSeries<T extends { net: number }>(series: T[], percentileValue: number, smoothingLength: number): T[] {
  if (!series.length) return [];
  const values = series.map((point) => Math.abs(point.net)).sort((a, b) => a - b);
  const ceiling = values[Math.min(values.length - 1, Math.floor((values.length - 1) * Math.max(0, Math.min(1, percentileValue / 100))))] || 1;
  const alpha = 2 / (Math.max(1, smoothingLength) + 1);
  let ema = Math.max(-ceiling, Math.min(ceiling, series[0].net));
  return series.map((point) => {
    const clipped = Math.max(-ceiling, Math.min(ceiling, point.net));
    ema += alpha * (clipped - ema);
    return { ...point, net: ema };
  });
}

export function bucketAndSmoothCvd(points: Array<{ time: number; value: number }>, bucketSeconds: number, smoothingLength: number, secondarySmoothing = 1) {
  if (!points.length) return [];
  const buckets = new Map<number, number>();
  for (const point of points) {
    const time = point.time > 100000000000 ? Math.floor(point.time / 1000) : point.time;
    buckets.set(Math.floor(time / Math.max(1, bucketSeconds)) * Math.max(1, bucketSeconds), point.value);
  }
  const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const primaryAlpha = 2 / (Math.max(1, smoothingLength) + 1);
  const secondaryAlpha = 2 / (Math.max(1, secondarySmoothing) + 1);
  let primary = ordered[0][1];
  let secondary = primary;
  return ordered.map(([time, value]) => {
    primary += primaryAlpha * (value - primary);
    secondary += secondaryAlpha * (primary - secondary);
    return { time, value: secondary };
  });
}

function wallRank(wall: WallRecord, mode: string) {
  if (mode === "persistence" || mode === "age") return wall.persistenceMs;
  if (mode === "size") return wall.size;
  if (mode === "distance") return -wall.distancePct;
  if (mode === "strength") return wall.score;
  return wall.reliability;
}

function mapMetrics(raw: DomMetrics, previous: DomMetrics, alpha: number): DomMetrics {
  const blend = (next: number, before: number) => before + alpha * (next - before);
  return {
    orderBookImbalance: blend(raw.orderBookImbalance, previous.orderBookImbalance),
    depthImbalance: blend(raw.depthImbalance, previous.depthImbalance),
    liquidityScore: blend(raw.liquidityScore, previous.liquidityScore),
    largeTradesLastMinute: blend(raw.largeTradesLastMinute, previous.largeTradesLastMinute),
    bidStacked: blend(raw.bidStacked, previous.bidStacked),
    askStacked: blend(raw.askStacked, previous.askStacked),
    bidPulled: blend(raw.bidPulled, previous.bidPulled),
    askPulled: blend(raw.askPulled, previous.askPulled),
    updateRate: blend(raw.updateRate, previous.updateRate),
    latencyMs: blend(raw.latencyMs, previous.latencyMs)
  };
}
