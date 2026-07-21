import { Candle } from "../types";

export type VolatilityHeatmapCell = {
  startIndex: number;
  endIndex: number;
  price: number;
  priceLow: number;
  priceHigh: number;
  strength: number;
  side: "support" | "resistance";
  volume: number;
  sourceCount: number;
  hot: boolean;
};

type ClusterBucket = {
  key: number;
  priceLow: number;
  priceHigh: number;
  price: number;
  volume: number;
  createdIndex: number;
  updatedIndex: number;
  sourceCount: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sign(value: number) {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function smaAt(values: number[], index: number, length: number) {
  const start = Math.max(0, index - length + 1);
  let total = 0;
  for (let i = start; i <= index; i++) total += values[i] ?? 0;
  return total / Math.max(1, index - start + 1);
}

function percentileNearestRank(values: number[], percentile: number) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((clamp(percentile, 0, 100) / 100) * clean.length));
  return clean[Math.min(clean.length - 1, rank - 1)] ?? 0;
}

function projectionFactors(baseTfMinutes = 1) {
  const base = Math.max(1e-8, baseTfMinutes);
  const timeframes = [1, 5, 15, 30, 60, 240];
  const multipliers = [1, 1.5, 2];
  return timeframes.flatMap((tf) => multipliers.map((multiplier) => Math.sqrt(tf / base) * multiplier));
}

function signatureFor(candles: Candle[], period: number) {
  const first = candles[0];
  const last = candles[candles.length - 1];
  return `vae:${period}:${candles.length}:${first?.time ?? 0}:${last?.time ?? 0}:${last?.close ?? 0}:${last?.volume ?? 0}`;
}

function buildAtrSeries(source: Candle[]) {
  const trueRanges = source.map((candle, index) => {
    const previous = source[index - 1];
    return Math.max(
      candle.high - candle.low,
      previous ? Math.abs(candle.high - previous.close) : 0,
      previous ? Math.abs(candle.low - previous.close) : 0,
      candle.close * 0.00001,
      1e-8
    );
  });

  const atr: number[] = [];
  for (let index = 0; index < trueRanges.length; index++) {
    const tr = trueRanges[index] ?? 0;
    atr.push(index === 0 ? tr : ((atr[index - 1] ?? tr) * 13 + tr) / 14);
  }
  return atr;
}

export class VolatilityHeatmapModel {
  private signature = "";
  private cells: VolatilityHeatmapCell[] = [];

  setSource(candles: Candle[], period: number) {
    const signature = signatureFor(candles, period);
    if (signature === this.signature) return;

    this.signature = signature;
    this.cells = this.buildCells(candles, period);
  }

  visibleCells(firstIndex: number, lastIndex: number, untilIndex: number, _priceMin: number, _priceMax: number) {
    if (this.cells.length === 0) return [];

    const boundedUntil = Math.max(0, untilIndex);

    return this.cells.filter(
      (cell) =>
        cell.startIndex <= Math.min(lastIndex, boundedUntil) &&
        cell.endIndex >= firstIndex
    );
  }

  private buildCells(candles: Candle[], rawPeriod: number) {
    const period = clamp(Math.round(rawPeriod), 5, 300);
    if (candles.length < Math.max(80, period + 20)) return [];

    const maxSource = 12000;
    const offset = Math.max(0, candles.length - maxSource);
    const source = candles.slice(offset);
    const atr = buildAtrSeries(source);
    const firstReadyIndex = Math.min(source.length - 1, 49);
    const frozenAtrProxy = smaAt(atr, firstReadyIndex, 50) || median(atr.filter((value) => value > 0));
    const lastClose = source[source.length - 1]?.close ?? 1;
    const gridSize = Math.max(lastClose * 0.00001, frozenAtrProxy / 4, 1e-8);
    const factors = projectionFactors(1);
    const active = new Map<number, ClusterBucket>();
    const maxActiveClusters = 2500;

    for (let index = Math.max(1, firstReadyIndex); index < source.length; index++) {
      const candle = source[index];
      const previous = source[index - 1];
      if (!candle || !previous) continue;

      this.removeCrossed(active, candle.low, candle.high);
      this.removeGapThrough(active, candle, previous);

      const signedVolume = candle.volume * sign(candle.close - previous.close) * -1;
      const direction = sign(signedVolume);
      if (direction === 0 || candle.volume <= 0) continue;

      const domPoint = (candle.high + candle.low + candle.close) / 3;
      const atrValue = Math.max(atr[index] ?? candle.high - candle.low, candle.close * 0.00001, 1e-8);
      const volumePerLevel = signedVolume / factors.length;

      for (const factor of factors) {
        const level = domPoint + atrValue * factor * direction;
        this.addCluster(active, source, level, volumePerLevel, gridSize, index);
      }

      if (active.size > maxActiveClusters) {
        this.pruneFurthest(active, candle.close, maxActiveClusters);
      }
    }

    const close = source[source.length - 1]?.close ?? 0;
    return this.toVisibleCells([...active.values()], close, offset, source.length - 1 + offset);
  }

  private addCluster(active: Map<number, ClusterBucket>, source: Candle[], level: number, volume: number, gridSize: number, index: number) {
    const key = Math.ceil(level / gridSize);
    const priceLow = key * gridSize;
    const priceHigh = priceLow + gridSize;
    const price = (priceLow + priceHigh) / 2;
    const existing = active.get(key);

    if (!existing) {
      active.set(key, {
        key,
        priceLow,
        priceHigh,
        price,
        volume,
        createdIndex: this.findStartIndex(source, index, priceLow, priceHigh),
        updatedIndex: index,
        sourceCount: 1
      });
      return;
    }

    const existingWeight = Math.abs(existing.volume);
    const nextWeight = Math.abs(volume);
    const totalWeight = existingWeight + nextWeight;
    existing.price = totalWeight > 0 ? (existing.price * existingWeight + price * nextWeight) / totalWeight : price;
    existing.priceLow = Math.min(existing.priceLow, priceLow);
    existing.priceHigh = Math.max(existing.priceHigh, priceHigh);
    existing.volume += volume;
    existing.updatedIndex = index;
    existing.sourceCount += 1;
  }

  private findStartIndex(source: Candle[], originIndex: number, priceLow: number, priceHigh: number) {
    const end = Math.max(0, originIndex - 1000);
    for (let index = originIndex - 1; index >= end; index--) {
      const candle = source[index];
      if (!candle) continue;
      if (Math.max(candle.low, priceLow) <= Math.min(candle.high, priceHigh)) return index;
    }
    return Math.max(0, originIndex - 120);
  }

  private removeCrossed(active: Map<number, ClusterBucket>, low: number, high: number) {
    for (const [key, cluster] of active) {
      if (Math.max(low, cluster.priceLow) <= Math.min(high, cluster.priceHigh)) {
        active.delete(key);
      }
    }
  }

  private removeGapThrough(active: Map<number, ClusterBucket>, candle: Candle, previous: Candle) {
    if (candle.open > previous.high) {
      this.removeCrossed(active, previous.high, candle.open);
    } else if (candle.open < previous.low) {
      this.removeCrossed(active, candle.open, previous.low);
    }
  }

  private pruneFurthest(active: Map<number, ClusterBucket>, close: number, maxActiveClusters: number) {
    const keep = [...active.values()]
      .sort((a, b) => Math.abs(b.volume) - Math.abs(a.volume))
      .slice(0, 40)
      .map((cluster) => cluster.key);
    const protectedKeys = new Set(keep);
    const removable = [...active.values()]
      .filter((cluster) => !protectedKeys.has(cluster.key))
      .sort((a, b) => Math.abs(b.price - close) - Math.abs(a.price - close));

    for (let index = 0; index < removable.length && active.size > maxActiveClusters; index++) {
      active.delete(removable[index]!.key);
    }
  }

  private toVisibleCells(clusters: ClusterBucket[], close: number, offset: number, lastIndex: number) {
    const sorted = clusters
      .filter((cluster) => Math.abs(cluster.volume) > 0)
      .sort((a, b) => a.price - b.price);
    if (sorted.length === 0) return [];

    const closestIndex = sorted.reduce((bestIndex, cluster, index) => {
      const best = sorted[bestIndex];
      if (!best) return index;
      return Math.abs(cluster.price - close) < Math.abs(best.price - close) ? index : bestIndex;
    }, 0);
    const targetCount = Math.min(495, sorted.length);
    let start = Math.max(0, closestIndex - Math.floor(targetCount / 2));
    let end = Math.min(sorted.length, start + targetCount);
    start = Math.max(0, end - targetCount);
    const selected = sorted.slice(start, end);
    const allVolumes = sorted.map((cluster) => Math.abs(cluster.volume));
    const selectedVolumes = selected.map((cluster) => Math.abs(cluster.volume));
    const p95 = percentileNearestRank(allVolumes, 95);
    const topFive = [...allVolumes].sort((a, b) => b - a).slice(0, 5);
    const hotThreshold = Math.max(p95, topFive[topFive.length - 1] ?? p95);
    const maxVolume = Math.max(...selectedVolumes, hotThreshold, 1);

    return selected
      .map((zone): VolatilityHeatmapCell => {
        const absVolume = Math.abs(zone.volume);
        const hot = absVolume >= hotThreshold;
        const strength = hot
          ? clamp(Math.pow(absVolume / maxVolume, 0.62), 0.68, 1)
          : clamp(Math.pow(absVolume / maxVolume, 0.72), 0.08, 0.56);
        return {
          startIndex: Math.max(0, zone.createdIndex + offset),
          endIndex: lastIndex + 500,
          price: zone.price,
          priceLow: zone.priceLow,
          priceHigh: zone.priceHigh,
          strength,
          side: zone.price < close ? "support" : "resistance",
          volume: zone.volume,
          sourceCount: zone.sourceCount,
          hot
        };
      })
      .sort((a, b) => a.price - b.price);
  }
}
