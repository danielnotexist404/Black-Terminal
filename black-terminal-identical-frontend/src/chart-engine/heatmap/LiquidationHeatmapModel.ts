import { Candle } from "../types";

export type LiquidationSide = "long" | "short";

export type LiquidationHeatmapCell = {
  startIndex: number;
  endIndex: number;
  price: number;
  priceLow: number;
  priceHigh: number;
  strength: number;
  side: LiquidationSide;
};

export type LiquidationHeatmapLevel = {
  price: number;
  strength: number;
  side: LiquidationSide;
};

type ActiveLevel = {
  key: string;
  price: number;
  score: number;
  longScore: number;
  shortScore: number;
};

type OpenCell = LiquidationHeatmapCell & {
  lastTouched: number;
};

const leverageTiers = [
  { leverage: 5, weight: 0.34 },
  { leverage: 10, weight: 0.56 },
  { leverage: 25, weight: 0.94 },
  { leverage: 50, weight: 1.18 },
  { leverage: 100, weight: 0.82 }
];

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function niceBucketSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;

  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * base;
}

function signatureFor(candles: Candle[]) {
  const first = candles[0];
  const last = candles[candles.length - 1];
  return `${candles.length}:${first?.time ?? 0}:${last?.time ?? 0}:${last?.close ?? 0}:${last?.volume ?? 0}`;
}

export class LiquidationHeatmapModel {
  private signature = "";
  private cells: LiquidationHeatmapCell[] = [];
  private bucketSize = 1;

  setSource(candles: Candle[]) {
    const signature = signatureFor(candles);
    if (signature === this.signature) return;

    this.signature = signature;
    this.cells = this.buildCells(candles);
  }

  visibleCells(firstIndex: number, lastIndex: number, untilIndex: number, priceMin: number, priceMax: number) {
    if (this.cells.length === 0) return [];

    const min = priceMin - (priceMax - priceMin) * 0.04;
    const max = priceMax + (priceMax - priceMin) * 0.04;
    const boundedUntil = Math.max(0, untilIndex);

    return this.cells.filter(
      (cell) =>
        cell.startIndex <= Math.min(lastIndex, boundedUntil) &&
        cell.endIndex >= firstIndex &&
        cell.priceHigh >= min &&
        cell.priceLow <= max &&
        cell.startIndex <= boundedUntil
    );
  }

  liquidityLevels(untilIndex: number, priceMin: number, priceMax: number, maxLevels = 5): LiquidationHeatmapLevel[] {
    const lookback = Math.max(60, Math.round((untilIndex + 1) * 0.05));
    const active = this.cells
      .filter(
        (cell) =>
          cell.startIndex <= untilIndex &&
          cell.endIndex >= untilIndex - lookback &&
          cell.price >= priceMin &&
          cell.price <= priceMax &&
          cell.strength >= 0.36
      )
      .sort((a, b) => b.strength - a.strength);

    const selected: LiquidationHeatmapLevel[] = [];
    const range = Math.max(1, priceMax - priceMin);

    for (const cell of active) {
      if (selected.some((level) => Math.abs(level.price - cell.price) < range * 0.028)) continue;
      selected.push({
        price: cell.price,
        strength: cell.strength,
        side: cell.side
      });
      if (selected.length >= maxLevels) break;
    }

    return selected;
  }

  private buildCells(candles: Candle[]) {
    if (candles.length < 24) return [];

    const source = candles.slice(-12000);
    const ranges = source
      .slice(Math.max(0, source.length - 420))
      .map((candle) => Math.max(0, candle.high - candle.low))
      .filter((value) => value > 0);
    const lastPrice = source[source.length - 1]?.close ?? 1;
    this.bucketSize = niceBucketSize(Math.max(median(ranges) * 0.22, lastPrice * 0.00055, 1));

    const maxVolume = Math.max(...source.map((candle) => candle.volume), 1);
    const activeLevels = new Map<string, ActiveLevel>();
    const openCells = new Map<string, OpenCell>();
    const cells: LiquidationHeatmapCell[] = [];
    let runningMax = 1;

    const bucketPrice = (price: number) => Math.round(price / this.bucketSize) * this.bucketSize;
    const keyFor = (price: number) => String(Math.round(price / this.bucketSize));

    const addLevel = (price: number, score: number, side: LiquidationSide) => {
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(score) || score <= 0) return;

      const key = keyFor(price);
      const level = activeLevels.get(key) ?? {
        key,
        price: bucketPrice(price),
        score: 0,
        longScore: 0,
        shortScore: 0
      };

      const previousScore = level.score;
      level.score += score;
      level.price = previousScore > 0 ? (level.price * previousScore + price * score) / (previousScore + score) : bucketPrice(price);
      if (side === "long") level.longScore += score;
      else level.shortScore += score;
      activeLevels.set(key, level);
    };

    for (let index = 0; index < source.length; index++) {
      const candle = source[index];
      const previous = source[index - 1];

      for (const [key, level] of activeLevels) {
        level.score *= 0.988;
        level.longScore *= 0.988;
        level.shortScore *= 0.988;
        if (level.score < 0.006) {
          activeLevels.delete(key);
          openCells.delete(key);
        }
      }

      const span = Math.max(candle.high - candle.low, candle.close * 0.00001, 1);
      const bodyPressure = Math.min(1, Math.abs(candle.close - candle.open) / span);
      const volumeWeight = Math.sqrt(Math.max(0, candle.volume) / maxVolume) * (0.54 + bodyPressure * 0.78);
      const directionWeight = previous ? 0.84 + Math.min(0.42, Math.abs(candle.close - previous.close) / Math.max(span, 1)) : 1;
      const references = [
        { price: candle.close, weight: 1 },
        { price: candle.open, weight: 0.54 },
        { price: candle.high, weight: 0.28 },
        { price: candle.low, weight: 0.28 }
      ];

      for (const reference of references) {
        for (const tier of leverageTiers) {
          const liquidationDistance = 0.92 / tier.leverage;
          const score = reference.weight * tier.weight * volumeWeight * directionWeight;
          addLevel(reference.price * (1 + liquidationDistance), score, "short");
          addLevel(reference.price * (1 - liquidationDistance), score, "long");
        }
      }

      const prevA = source[index - 1];
      const prevB = source[index - 2];
      const nextA = source[index + 1];
      const nextB = source[index + 2];
      const swingHigh = prevA && prevB && nextA && nextB && candle.high >= prevA.high && candle.high >= prevB.high && candle.high >= nextA.high && candle.high >= nextB.high;
      const swingLow = prevA && prevB && nextA && nextB && candle.low <= prevA.low && candle.low <= prevB.low && candle.low <= nextA.low && candle.low <= nextB.low;
      const swingWeight = volumeWeight * 4.4;

      if (swingHigh) {
        addLevel(candle.high * 1.014, swingWeight, "short");
        addLevel(candle.high * 1.029, swingWeight * 0.72, "short");
      }
      if (swingLow) {
        addLevel(candle.low * 0.986, swingWeight, "long");
        addLevel(candle.low * 0.971, swingWeight * 0.72, "long");
      }

      const ranked = [...activeLevels.values()].sort((a, b) => b.score - a.score).slice(0, 44);
      runningMax = Math.max(runningMax * 0.998, ranked[0]?.score ?? 1);
      const touched = new Set<string>();

      for (const level of ranked) {
        const strength = Math.min(1, Math.pow(level.score / Math.max(1e-8, runningMax), 0.64));
        if (strength < 0.11) continue;

        const side: LiquidationSide = level.shortScore >= level.longScore ? "short" : "long";
        const cellKey = `${level.key}:${side}`;
        touched.add(cellKey);

        const existing = openCells.get(cellKey);
        if (existing && existing.endIndex >= index - 1) {
          existing.endIndex = index;
          existing.lastTouched = index;
          existing.price = existing.price * 0.96 + level.price * 0.04;
          existing.priceLow = existing.price - this.bucketSize * 0.5;
          existing.priceHigh = existing.price + this.bucketSize * 0.5;
          existing.strength = Math.max(existing.strength * 0.992, strength);
          continue;
        }

        const next: OpenCell = {
          startIndex: index,
          endIndex: index,
          lastTouched: index,
          price: level.price,
          priceLow: level.price - this.bucketSize * 0.5,
          priceHigh: level.price + this.bucketSize * 0.5,
          strength,
          side
        };
        openCells.set(cellKey, next);
        cells.push(next);
      }

      for (const [key, cell] of openCells) {
        if (!touched.has(key) && cell.lastTouched < index - 2) {
          openCells.delete(key);
        }
      }
    }

    return cells.filter((cell) => cell.endIndex - cell.startIndex >= 1 || cell.strength >= 0.42);
  }
}
