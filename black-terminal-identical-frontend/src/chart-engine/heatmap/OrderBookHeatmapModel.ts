import { Candle } from "../types";
import { OrderBookSnapshot } from "../../market-data/types";

type Side = "bid" | "ask";

type StoredSnapshot = {
  time: number;
  xIndex: number;
  bids: [number, number][];
  asks: [number, number][];
};

type BookBucket = {
  price: number;
  bid: number;
  ask: number;
};

export type OrderBookHeatmapCell = {
  xStartIndex: number;
  xEndIndex: number;
  price: number;
  priceLow: number;
  priceHigh: number;
  strength: number;
  side: Side;
};

function niceBucketSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * base;
}

export class OrderBookHeatmapModel {
  private candles: Candle[] = [];
  private snapshots: StoredSnapshot[] = [];
  private maxSnapshots = 360;
  private maxLevelsPerSide = 240;

  setCandles(candles: Candle[]) {
    this.candles = candles;
    if (this.snapshots.length === 0) return;

    this.snapshots = this.snapshots.map((snapshot) => ({
      ...snapshot,
      xIndex: this.indexForTime(snapshot.time)
    }));
  }

  ingest(snapshot: OrderBookSnapshot) {
    const bids = snapshot.bids
      .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.quantity) && level.quantity > 0)
      .slice(0, this.maxLevelsPerSide)
      .map((level) => [level.price, level.quantity] as [number, number]);
    const asks = snapshot.asks
      .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.quantity) && level.quantity > 0)
      .slice(0, this.maxLevelsPerSide)
      .map((level) => [level.price, level.quantity] as [number, number]);

    if (bids.length === 0 && asks.length === 0) return;

    const stored: StoredSnapshot = {
      time: snapshot.time,
      xIndex: this.indexForTime(snapshot.time),
      bids,
      asks
    };

    const previous = this.snapshots[this.snapshots.length - 1];
    if (previous && Math.abs(previous.time - stored.time) < 0.35) {
      this.snapshots[this.snapshots.length - 1] = stored;
    } else {
      this.snapshots.push(stored);
    }

    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots);
    }
  }

  cells(firstIndex: number, lastIndex: number, priceMin: number, priceMax: number) {
    if (this.snapshots.length === 0 || this.candles.length === 0) return [];

    const range = Math.max(1, priceMax - priceMin);
    const bucketSize = niceBucketSize(Math.max(range / 220, this.midPrice() * 0.00012, 0.01));
    const visibleSpan = Math.max(1, lastIndex - firstIndex + 1);
    const firstSnapshot = this.snapshots[0];
    const lastSnapshot = this.snapshots[this.snapshots.length - 1];
    const recordedSpan = Math.max(0, (lastSnapshot?.xIndex ?? 0) - (firstSnapshot?.xIndex ?? 0));
    const isWarming = recordedSpan < visibleSpan * 0.55;
    const projectionWeight = isWarming ? 0.78 : 0.24;
    const rawCells: Array<OrderBookHeatmapCell & { notional: number }> = [];

    this.addProjectedBookCells(
      rawCells,
      firstIndex - 1,
      lastIndex + 1.2,
      priceMin,
      priceMax,
      bucketSize,
      projectionWeight
    );

    const sourceSnapshots = isWarming ? this.snapshots.slice(-48) : this.snapshots;
    const visibleSnapshots = sourceSnapshots.filter((snapshot) => {
      const sourceIndex = this.snapshots.indexOf(snapshot);
      const next = this.snapshots[sourceIndex + 1];
      const segmentStart = sourceIndex === 0 ? snapshot.xIndex - 2 : snapshot.xIndex;
      const segmentEnd = isWarming
        ? snapshot.xIndex + Math.max(1.4, Math.min(8, visibleSpan * 0.02))
        : next?.xIndex ?? snapshot.xIndex + Math.max(1, Math.min(8, visibleSpan * 0.014));
      return segmentEnd >= firstIndex - 1 && segmentStart <= lastIndex + 1;
    });

    for (const snapshot of visibleSnapshots) {
      const sourceIndex = this.snapshots.indexOf(snapshot);
      const nextSnapshot = this.snapshots[sourceIndex + 1];
      const segmentStart = sourceIndex === 0
        ? Math.max(firstIndex, snapshot.xIndex - 2)
        : Math.max(firstIndex, snapshot.xIndex);
      const segmentEnd = Math.min(
        lastIndex + 1.2,
        isWarming
          ? snapshot.xIndex + Math.max(1.4, Math.min(8, visibleSpan * 0.02))
          : nextSnapshot?.xIndex ?? snapshot.xIndex + Math.max(1, Math.min(8, visibleSpan * 0.014))
      );
      if (segmentEnd <= segmentStart) continue;

      this.addSnapshotCells(rawCells, snapshot, segmentStart, segmentEnd, priceMin, priceMax, bucketSize, isWarming ? 0.44 : 1);
    }

    const sortedNotionals = rawCells.map((cell) => cell.notional).sort((a, b) => a - b);
    const scale = sortedNotionals[Math.floor(sortedNotionals.length * 0.985)] ?? sortedNotionals[sortedNotionals.length - 1] ?? 1;
    return rawCells.map(({ notional, ...cell }) => ({
      ...cell,
      strength: Math.min(1, Math.pow(notional / Math.max(1, scale), 0.54))
    }));
  }

  private addProjectedBookCells(
    cells: Array<OrderBookHeatmapCell & { notional: number }>,
    xStartIndex: number,
    xEndIndex: number,
    priceMin: number,
    priceMax: number,
    bucketSize: number,
    weight: number
  ) {
    const recent = this.snapshots.slice(-72);
    if (recent.length === 0 || xEndIndex <= xStartIndex) return;

    const buckets = new Map<string, BookBucket>();
    const range = Math.max(1, priceMax - priceMin);

    recent.forEach((snapshot, index) => {
      const recency = (index + 1) / recent.length;
      const snapshotWeight = (0.25 + recency * recency * 0.75) / recent.length;
      this.collectBuckets(snapshot, buckets, priceMin - range * 0.05, priceMax + range * 0.05, bucketSize, snapshotWeight);
    });

    this.pushBucketsAsCells(cells, buckets, xStartIndex, xEndIndex, bucketSize, weight);
  }

  private addSnapshotCells(
    cells: Array<OrderBookHeatmapCell & { notional: number }>,
    snapshot: StoredSnapshot,
    xStartIndex: number,
    xEndIndex: number,
    priceMin: number,
    priceMax: number,
    bucketSize: number,
    weight: number
  ) {
    const range = Math.max(1, priceMax - priceMin);
    const buckets = new Map<string, BookBucket>();
    this.collectBuckets(snapshot, buckets, priceMin - range * 0.04, priceMax + range * 0.04, bucketSize, 1);
    this.pushBucketsAsCells(cells, buckets, xStartIndex, xEndIndex, bucketSize, weight);
  }

  private collectBuckets(
    snapshot: StoredSnapshot,
    buckets: Map<string, BookBucket>,
    priceMin: number,
    priceMax: number,
    bucketSize: number,
    weight: number
  ) {
    const add = (side: Side, price: number, quantity: number) => {
      if (price < priceMin || price > priceMax) return;
      const bucket = Math.round(price / bucketSize) * bucketSize;
      const key = String(bucket);
      const current = buckets.get(key) ?? { price: bucket, bid: 0, ask: 0 };
      current[side === "bid" ? "bid" : "ask"] += quantity * price * weight;
      buckets.set(key, current);
    };

    snapshot.bids.forEach(([price, quantity]) => add("bid", price, quantity));
    snapshot.asks.forEach(([price, quantity]) => add("ask", price, quantity));
  }

  private pushBucketsAsCells(
    cells: Array<OrderBookHeatmapCell & { notional: number }>,
    buckets: Map<string, BookBucket>,
    xStartIndex: number,
    xEndIndex: number,
    bucketSize: number,
    weight: number
  ) {
    for (const bucket of buckets.values()) {
      if (bucket.bid > 0) {
        cells.push({
          xStartIndex,
          xEndIndex,
          price: bucket.price,
          priceLow: bucket.price - bucketSize * 0.42,
          priceHigh: bucket.price + bucketSize * 0.42,
          strength: 0,
          side: "bid",
          notional: bucket.bid * weight
        });
      }
      if (bucket.ask > 0) {
        cells.push({
          xStartIndex,
          xEndIndex,
          price: bucket.price,
          priceLow: bucket.price - bucketSize * 0.42,
          priceHigh: bucket.price + bucketSize * 0.42,
          strength: 0,
          side: "ask",
          notional: bucket.ask * weight
        });
      }
    }
  }

  private midPrice() {
    const last = this.candles[this.candles.length - 1];
    return last?.close ?? 1;
  }

  private indexForTime(time: number) {
    if (this.candles.length === 0) return 0;
    if (this.candles.length === 1) return 0;

    let low = 0;
    let high = this.candles.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candle = this.candles[mid];
      if (!candle) break;
      if (candle.time <= time) low = mid + 1;
      else high = mid - 1;
    }

    const index = Math.max(0, Math.min(this.candles.length - 1, high));
    const current = this.candles[index];
    const next = this.candles[index + 1];
    const fallbackStep = Math.max(1, (this.candles[index]?.time ?? 0) - (this.candles[index - 1]?.time ?? 0));
    const step = Math.max(1, (next?.time ?? ((current?.time ?? time) + fallbackStep)) - (current?.time ?? time));
    const fraction = current ? Math.max(0, Math.min(1.2, (time - current.time) / step)) : 0;

    return index + fraction;
  }
}
