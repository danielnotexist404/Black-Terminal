import type { OrderBookSnapshot } from "../../market-data/types";
import type { Candle } from "../types";
import { compactBookSnapshot, type BookHeatmapRejectionReason, type CompactedBookSnapshot } from "./bookHeatmapProcessor.ts";

export type BookHeatmapSide = "bid" | "ask";
export type BookHeatmapTradeSide = "buy" | "sell" | "unknown";
export type BookHeatmapClassification = "LIVE L2" | "HISTORICAL L2";
export type BookHeatmapFeedState = "idle" | "collecting" | "live" | "stale" | "resynchronizing" | "invalid";
export type BookHeatmapScaleMode = "adaptive" | "percentile" | "logarithmic" | "linear";

export type BookHeatmapVenueContribution = {
  bidNotional: number;
  askNotional: number;
};

export type HistoricalBookHeatmapCell = {
  time: string | number;
  bucketEnd?: string | number;
  price: number;
  bucketSize: number;
  bidSize: number;
  askSize: number;
  bidPeakSize?: number;
  askPeakSize?: number;
  observations?: number;
  liquidityScore?: number;
  gravityScore?: number;
  venues?: Record<string, {
    bidSize?: number;
    askSize?: number;
    bidPeakSize?: number;
    askPeakSize?: number;
    liquidityScore?: number;
    gravityScore?: number;
  }>;
};

export type OrderBookHeatmapCell = {
  xStartIndex: number;
  xEndIndex: number;
  price: number;
  priceLow: number;
  priceHigh: number;
  strength: number;
  side: BookHeatmapSide;
  notional: number;
  peakNotional: number;
  observations: number;
  firstSeenAt: number;
  lastSeenAt: number;
  persistenceMs: number;
  stackingNotional: number;
  pullingNotional: number;
  imbalance: number;
  replenishmentScore: number;
  spoofRisk: number;
  correlatedTradeNotional: number;
  estimatedConsumedNotional: number;
  estimatedCancelledNotional: number;
  absorptionScore: number;
  icebergProbability: number;
  confidence: number;
  analyticsBasis: "OBSERVED BOOK DELTAS" | "HISTORICAL DEPTH TILES";
  classification: BookHeatmapClassification;
  venues: Record<string, BookHeatmapVenueContribution>;
};

export type BookHeatmapDiagnostics = {
  state: BookHeatmapFeedState;
  classification: "AUTHENTIC L2 ONLY";
  venue: string | null;
  symbol: string | null;
  lastSourceAt: number | null;
  lastReceivedAt: number | null;
  latencyMs: number | null;
  acceptedSnapshots: number;
  rejectedSnapshots: number;
  duplicateSequences: number;
  sequenceRegressions: number;
  timestampRegressions: number;
  staleSnapshots: number;
  duplicateLevels: number;
  crossedBooks: number;
  invalidLevels: number;
  unverifiedQuantitySnapshots: number;
  backpressureDrops: number;
  liveFrames: number;
  historicalCells: number;
  historyFrom: number | null;
  historyTo: number | null;
  coverageMs: number;
  message: string;
  venues: Record<string, {
    state: BookHeatmapFeedState;
    lastSourceAt: number | null;
    lastReceivedAt: number | null;
    latencyMs: number | null;
  }>;
};

export type BookHeatmapModelSettings = {
  scaleMode: BookHeatmapScaleMode;
  percentile: number;
  minimumNotional: number;
  staleAfterMs: number;
  maxLiveFrames: number;
  captureIntervalMs: number;
  consolidated: boolean;
};

type CompactFrame = {
  sourceAt: number;
  receivedAt: number;
  xIndex: number;
  venue: string;
  symbol: string;
  sequence?: number;
  bucketSize: number;
  // Repeating [price, bidNotional, askNotional]. A compact typed representation
  // avoids retaining hundreds of JS level objects for every visual observation.
  buckets: Float64Array;
};

type IndexedHistoricalCell = HistoricalBookHeatmapCell & {
  xStartIndex: number;
  xEndIndex: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

type RawCell = Omit<OrderBookHeatmapCell, "strength"> & { score: number };

type CompactTrade = {
  time: number;
  price: number;
  notional: number;
  side: BookHeatmapTradeSide;
};

const DEFAULT_SETTINGS: BookHeatmapModelSettings = {
  scaleMode: "adaptive",
  percentile: 0.985,
  minimumNotional: 0,
  staleAfterMs: 8_000,
  maxLiveFrames: 1_200,
  captureIntervalMs: 500,
  consolidated: false
};

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toEpochMs(value: string | number | undefined) {
  if (typeof value === "string") return Date.parse(value);
  if (!Number.isFinite(value)) return Number.NaN;
  return Number(value) < 10_000_000_000 ? Number(value) * 1000 : Number(value);
}

function niceBucketSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * base;
}

function quantile(sorted: number[], percentile: number) {
  if (sorted.length === 0) return 1;
  const position = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile)));
  return sorted[position] ?? 1;
}

function normalizedSymbolKey(symbol: string) {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(?:PERPETUAL|PERP|SWAP)$/, "");
}

export class OrderBookHeatmapModel {
  private candles: Candle[] = [];
  private candleIndexSignature = "";
  private liveFrames: CompactFrame[] = [];
  private historicalCells: IndexedHistoricalCell[] = [];
  private historicalFrom: number | null = null;
  private historicalTo: number | null = null;
  private trades: CompactTrade[] = [];
  private settings: BookHeatmapModelSettings = { ...DEFAULT_SETTINGS };
  private activeSymbolKey: string | null = null;
  private lastAcceptedSequence = new Map<string, number>();
  private lastAcceptedSourceAt = new Map<string, number>();
  private lastRejectionReason = new Map<string, BookHeatmapRejectionReason | "duplicate_sequence" | "sequence_regression" | "timestamp_regression" | "stale_snapshot">();
  private lastRejectedVenue: string | null = null;
  private lastCaptureAt = new Map<string, number>();
  private venueStates = new Map<string, BookHeatmapFeedState>();
  private counters = {
    acceptedSnapshots: 0,
    rejectedSnapshots: 0,
    duplicateSequences: 0,
    sequenceRegressions: 0,
    timestampRegressions: 0,
    staleSnapshots: 0,
    duplicateLevels: 0,
    crossedBooks: 0,
    invalidLevels: 0,
    unverifiedQuantitySnapshots: 0,
    backpressureDrops: 0
  };
  private feedState: BookHeatmapFeedState = "idle";

  setCandles(candles: Candle[]) {
    this.candles = candles;
    const signature = `${candles.length}:${candles[0]?.time ?? 0}:${candles[candles.length - 1]?.time ?? 0}`;
    if (signature === this.candleIndexSignature) return;
    this.candleIndexSignature = signature;
    for (const frame of this.liveFrames) frame.xIndex = this.indexForTime(frame.sourceAt);
    this.reindexHistoricalCells();
  }

  setSettings(patch: Partial<BookHeatmapModelSettings>) {
    this.settings = {
      ...this.settings,
      ...patch,
      percentile: Math.max(0.5, Math.min(0.999, patch.percentile ?? this.settings.percentile)),
      minimumNotional: Math.max(0, patch.minimumNotional ?? this.settings.minimumNotional),
      staleAfterMs: Math.max(1_000, patch.staleAfterMs ?? this.settings.staleAfterMs),
      maxLiveFrames: Math.max(60, Math.min(7_200, Math.round(patch.maxLiveFrames ?? this.settings.maxLiveFrames))),
      captureIntervalMs: Math.max(100, Math.min(10_000, Math.round(patch.captureIntervalMs ?? this.settings.captureIntervalMs)))
    };
    this.trimLiveFrames();
  }

  ingest(snapshot: OrderBookSnapshot) {
    return this.ingestCompacted(compactBookSnapshot(snapshot));
  }

  ingestCompacted(snapshot: CompactedBookSnapshot) {
    const symbolKey = normalizedSymbolKey(snapshot.symbol);
    const venue = snapshot.venue;

    if (this.activeSymbolKey && this.activeSymbolKey !== symbolKey) this.resetMarket();
    this.activeSymbolKey = symbolKey;

    if (!snapshot.accepted) {
      this.counters.rejectedSnapshots += 1;
      this.counters.invalidLevels += snapshot.invalidLevels;
      this.counters.duplicateLevels += snapshot.duplicateLevels;
      if (snapshot.reason === "crossed_book") this.counters.crossedBooks += 1;
      if (snapshot.reason === "uncertified_quantity_unit") this.counters.unverifiedQuantitySnapshots += 1;
      this.lastRejectionReason.set(venue, snapshot.reason);
      this.lastRejectedVenue = venue;
      this.venueStates.set(venue, "invalid");
      this.feedState = "invalid";
      return { accepted: false, reason: snapshot.reason } as const;
    }

    const lastSourceAt = this.lastAcceptedSourceAt.get(venue);
    if (lastSourceAt !== undefined && snapshot.sourceAt < lastSourceAt) {
      this.counters.timestampRegressions += 1;
      this.counters.rejectedSnapshots += 1;
      this.lastRejectionReason.set(venue, "timestamp_regression");
      this.lastRejectedVenue = venue;
      this.venueStates.set(venue, "resynchronizing");
      this.feedState = "resynchronizing";
      return { accepted: false, reason: "timestamp_regression" } as const;
    }

    if (snapshot.receivedAt - snapshot.sourceAt > this.settings.staleAfterMs) {
      this.counters.staleSnapshots += 1;
      this.counters.rejectedSnapshots += 1;
      this.lastRejectionReason.set(venue, "stale_snapshot");
      this.lastRejectedVenue = venue;
      this.venueStates.set(venue, "stale");
      this.feedState = "stale";
      return { accepted: false, reason: "stale_snapshot" } as const;
    }

    const lastSequence = this.lastAcceptedSequence.get(venue);
    if (snapshot.sequence !== undefined && lastSequence !== undefined) {
      if (snapshot.sequence === lastSequence) {
        this.counters.duplicateSequences += 1;
        this.counters.rejectedSnapshots += 1;
        this.lastRejectionReason.set(venue, "duplicate_sequence");
        this.lastRejectedVenue = venue;
        return { accepted: false, reason: "duplicate_sequence" } as const;
      }
      if (snapshot.sequence < lastSequence) {
        this.counters.sequenceRegressions += 1;
        this.counters.rejectedSnapshots += 1;
        this.lastRejectionReason.set(venue, "sequence_regression");
        this.lastRejectedVenue = venue;
        this.venueStates.set(venue, "resynchronizing");
        this.feedState = "resynchronizing";
        return { accepted: false, reason: "sequence_regression" } as const;
      }
    }

    if (snapshot.sequence !== undefined) this.lastAcceptedSequence.set(venue, snapshot.sequence);
    this.lastAcceptedSourceAt.set(venue, snapshot.sourceAt);
    this.lastRejectionReason.delete(venue);
    this.venueStates.set(venue, "live");
    this.counters.acceptedSnapshots += 1;
    this.feedState = "live";

    const lastCaptureAt = this.lastCaptureAt.get(venue) ?? 0;
    if (snapshot.receivedAt - lastCaptureAt < this.settings.captureIntervalMs && this.liveFrames.some((frame) => frame.venue === venue)) {
      return { accepted: true, captured: false } as const;
    }

    this.liveFrames.push({
      sourceAt: snapshot.sourceAt,
      receivedAt: snapshot.receivedAt,
      xIndex: this.indexForTime(snapshot.sourceAt),
      venue: snapshot.venue,
      symbol: snapshot.symbol,
      sequence: snapshot.sequence,
      bucketSize: snapshot.bucketSize,
      buckets: snapshot.buckets
    });
    this.lastCaptureAt.set(venue, snapshot.receivedAt);
    this.trimLiveFrames();
    return { accepted: true, captured: true } as const;
  }

  recordBackpressureDrop(count = 1) {
    this.counters.backpressureDrops += Math.max(0, Math.round(count));
  }

  ingestTrade(price: number, quantity: number, time: number, side: BookHeatmapTradeSide = "unknown") {
    const epochMs = toEpochMs(time);
    if (!finitePositive(price) || !finitePositive(quantity) || !Number.isFinite(epochMs)) return false;
    const trade = { time: epochMs, price, notional: price * quantity, side };
    const last = this.trades[this.trades.length - 1];
    if (!last || last.time <= epochMs) this.trades.push(trade);
    else {
      const index = this.trades.findIndex((candidate) => candidate.time > epochMs);
      this.trades.splice(index < 0 ? this.trades.length : index, 0, trade);
    }
    if (this.trades.length > 5_000) this.trades.splice(0, this.trades.length - 5_000);
    return true;
  }

  replaceHistoricalCells(cells: HistoricalBookHeatmapCell[]) {
    const accepted = cells
      .filter((cell) => {
        const time = toEpochMs(cell.time);
        const end = toEpochMs(cell.bucketEnd ?? cell.time);
        return Number.isFinite(time) && Number.isFinite(end) && finitePositive(cell.price) && finitePositive(cell.bucketSize)
          && (finitePositive(cell.bidSize) || finitePositive(cell.askSize));
      })
      .sort((a, b) => toEpochMs(a.time) - toEpochMs(b.time) || a.price - b.price)
      .slice(-20_000);
    this.historicalCells = accepted.map((cell) => this.indexHistoricalCell(cell));
    const times = this.historicalCells.flatMap((cell) => [toEpochMs(cell.time), toEpochMs(cell.bucketEnd ?? cell.time)]);
    this.historicalFrom = times.length ? Math.min(...times) : null;
    this.historicalTo = times.length ? Math.max(...times) : null;
    if (this.feedState === "idle" && this.historicalCells.length > 0) this.feedState = "collecting";
  }

  clearHistoricalCells() {
    this.historicalCells = [];
    this.historicalFrom = null;
    this.historicalTo = null;
  }

  cells(firstIndex: number, lastIndex: number, priceMin: number, priceMax: number) {
    if (this.candles.length === 0 || priceMax <= priceMin) return [];
    const observed = [
      ...this.historicalCellsForView(firstIndex, lastIndex, priceMin, priceMax),
      ...this.liveCellsForView(firstIndex, lastIndex, priceMin, priceMax)
    ];
    const raw = (this.settings.consolidated ? this.consolidateRawCells(observed) : observed)
      .filter((cell) => cell.notional >= this.settings.minimumNotional);
    if (raw.length === 0) return [];

    const scores = raw.map((cell) => cell.score).filter(finitePositive).sort((a, b) => a - b);
    const reference = quantile(scores, this.settings.percentile);
    const maximum = scores[scores.length - 1] ?? reference;
    return raw.map(({ score, ...cell }) => ({
      ...cell,
      strength: this.normalizeStrength(score, reference, maximum)
    }));
  }

  diagnostics(now = Date.now()): BookHeatmapDiagnostics {
    const lastFrame = this.liveFrames[this.liveFrames.length - 1];
    const historyFrom = this.historicalFrom;
    const historyTo = this.historicalTo;
    const latestByVenue = new Map<string, CompactFrame>();
    for (const frame of this.liveFrames) latestByVenue.set(frame.venue, frame);
    const venueNames = new Set([...this.venueStates.keys(), ...latestByVenue.keys()]);
    const venues: BookHeatmapDiagnostics["venues"] = {};
    for (const venue of venueNames) {
      const frame = latestByVenue.get(venue);
      let venueState = this.venueStates.get(venue) ?? "idle";
      if (frame && venueState === "live" && now - frame.sourceAt > this.settings.staleAfterMs) venueState = "stale";
      venues[venue] = {
        state: venueState,
        lastSourceAt: frame?.sourceAt ?? null,
        lastReceivedAt: frame?.receivedAt ?? null,
        latencyMs: frame ? Math.max(0, frame.receivedAt - frame.sourceAt) : null
      };
    }
    const venueStateList = Object.values(venues).map((venue) => venue.state);
    let state: BookHeatmapFeedState = venueStateList.includes("live")
      ? "live"
      : venueStateList.includes("resynchronizing")
        ? "resynchronizing"
        : venueStateList.includes("invalid")
          ? "invalid"
          : venueStateList.includes("stale")
            ? "stale"
            : this.historicalCells.length > 0
              ? "collecting"
              : "idle";
    const lastReason = this.lastRejectedVenue ? this.lastRejectionReason.get(this.lastRejectedVenue) : undefined;
    const message = state === "live"
      ? `${venueStateList.filter((venueState) => venueState === "live").length} authentic L2 venue${venueStateList.filter((venueState) => venueState === "live").length === 1 ? "" : "s"} live`
      : state === "stale"
        ? "Live depth feed stale"
        : state === "resynchronizing"
          ? "Sequence integrity lost — resynchronizing"
          : state === "invalid"
            ? lastReason === "uncertified_quantity_unit"
              ? "Venue quantity units are not certified — live depth excluded"
              : lastReason === "duplicate_level"
                ? "Duplicate price levels rejected"
                : "Invalid order book rejected"
            : this.historicalCells.length > 0
              ? "Historical L2 loaded; collecting live depth"
              : "Collecting depth history";
    return {
      state,
      classification: "AUTHENTIC L2 ONLY",
      venue: this.settings.consolidated ? [...venueNames].join("+") || null : lastFrame?.venue ?? [...venueNames][0] ?? null,
      symbol: lastFrame?.symbol ?? this.activeSymbolKey,
      lastSourceAt: lastFrame?.sourceAt ?? null,
      lastReceivedAt: lastFrame?.receivedAt ?? null,
      latencyMs: lastFrame ? Math.max(0, lastFrame.receivedAt - lastFrame.sourceAt) : null,
      ...this.counters,
      liveFrames: this.liveFrames.length,
      historicalCells: this.historicalCells.length,
      historyFrom,
      historyTo,
      coverageMs: historyFrom !== null && historyTo !== null ? Math.max(0, historyTo - historyFrom) : 0,
      message,
      venues
    };
  }

  private resetMarket() {
    this.liveFrames = [];
    this.clearHistoricalCells();
    this.lastAcceptedSequence.clear();
    this.lastAcceptedSourceAt.clear();
    this.lastRejectionReason.clear();
    this.lastRejectedVenue = null;
    this.lastCaptureAt.clear();
    this.venueStates.clear();
    this.trades = [];
    this.feedState = "idle";
  }

  private trimLiveFrames() {
    if (this.liveFrames.length > this.settings.maxLiveFrames) {
      this.liveFrames.splice(0, this.liveFrames.length - this.settings.maxLiveFrames);
    }
  }

  private isVenueFresh(venue: string, now = Date.now()) {
    if (this.venueStates.get(venue) !== "live") return false;
    let lastFrame: CompactFrame | undefined;
    for (let index = this.liveFrames.length - 1; index >= 0; index -= 1) {
      if (this.liveFrames[index]?.venue === venue) {
        lastFrame = this.liveFrames[index];
        break;
      }
    }
    return Boolean(lastFrame && now - lastFrame.sourceAt <= this.settings.staleAfterMs);
  }

  private lowerBoundTradeTime(time: number) {
    let low = 0;
    let high = this.trades.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.trades[middle]?.time ?? Number.POSITIVE_INFINITY) < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private consolidateRawCells(cells: RawCell[]) {
    const grouped = new Map<string, RawCell>();
    for (const cell of cells) {
      const key = `${cell.classification}:${cell.side}:${cell.xStartIndex.toFixed(4)}:${cell.xEndIndex.toFixed(4)}:${cell.price.toFixed(8)}`;
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, { ...cell, venues: { ...cell.venues } });
        continue;
      }
      const previousNotional = current.notional;
      const combinedNotional = previousNotional + cell.notional;
      current.notional = combinedNotional;
      current.peakNotional += cell.peakNotional;
      current.observations += cell.observations;
      current.firstSeenAt = Math.min(current.firstSeenAt, cell.firstSeenAt);
      current.lastSeenAt = Math.max(current.lastSeenAt, cell.lastSeenAt);
      current.persistenceMs = Math.max(0, current.lastSeenAt - current.firstSeenAt);
      current.stackingNotional += cell.stackingNotional;
      current.pullingNotional += cell.pullingNotional;
      current.correlatedTradeNotional += cell.correlatedTradeNotional;
      current.estimatedConsumedNotional += cell.estimatedConsumedNotional;
      current.estimatedCancelledNotional += cell.estimatedCancelledNotional;
      current.imbalance = (current.imbalance * previousNotional + cell.imbalance * cell.notional) / Math.max(1, combinedNotional);
      current.replenishmentScore = Math.max(current.replenishmentScore, cell.replenishmentScore);
      current.spoofRisk = Math.max(current.spoofRisk, cell.spoofRisk);
      current.absorptionScore = Math.max(current.absorptionScore, cell.absorptionScore);
      current.icebergProbability = Math.max(current.icebergProbability, cell.icebergProbability);
      current.confidence = Math.min(1, Math.max(current.confidence, cell.confidence) + Math.min(0.18, Object.keys(cell.venues).length * 0.06));
      current.score += cell.score;
      for (const [venue, contribution] of Object.entries(cell.venues)) {
        const existing = current.venues[venue] ?? { bidNotional: 0, askNotional: 0 };
        existing.bidNotional += contribution.bidNotional;
        existing.askNotional += contribution.askNotional;
        current.venues[venue] = existing;
      }
    }
    return [...grouped.values()];
  }

  private liveCellsForView(firstIndex: number, lastIndex: number, priceMin: number, priceMax: number): RawCell[] {
    const result: RawCell[] = [];
    const previous = new Map<string, number>();
    const lifecycle = new Map<string, { firstSeenAt: number; observations: number; peakNotional: number; priorPulling: number }>();
    const firstFrameX = this.liveFrames[0]?.xIndex ?? 0;
    const lastFrameX = this.liveFrames[this.liveFrames.length - 1]?.xIndex ?? firstFrameX;
    const observedCandleSpan = Math.max(1, Math.ceil(lastFrameX - firstFrameX + 1));
    const outputFrameTarget = Math.max(80, Math.min(360, observedCandleSpan * 8));
    const outputStride = Math.max(1, Math.ceil(this.liveFrames.length / outputFrameTarget));
    const nextFrameByIndex = new Map<number, CompactFrame>();
    const nextByVenue = new Map<string, CompactFrame>();
    for (let index = this.liveFrames.length - 1; index >= 0; index -= 1) {
      const frame = this.liveFrames[index];
      const next = nextByVenue.get(frame.venue);
      if (next) nextFrameByIndex.set(index, next);
      nextByVenue.set(frame.venue, frame);
    }
    const venueFrameOrdinals = new Map<string, number>();
    for (let frameIndex = 0; frameIndex < this.liveFrames.length; frameIndex += 1) {
      const frame = this.liveFrames[frameIndex];
      if (!this.isVenueFresh(frame.venue)) continue;
      const next = nextFrameByIndex.get(frameIndex);
      const xStartIndex = frame.xIndex;
      const xEndIndex = next ? Math.max(xStartIndex, next.xIndex) : xStartIndex;
      const venueOrdinal = venueFrameOrdinals.get(frame.venue) ?? 0;
      venueFrameOrdinals.set(frame.venue, venueOrdinal + 1);
      const emitFrame = venueOrdinal % outputStride === 0 || !next;
      const currentKeys = new Set<string>();
      const correlatedTrades = new Map<string, number>();
      const tradeCutoff = next?.sourceAt ?? frame.sourceAt + this.settings.captureIntervalMs;
      let frameTradeCursor = this.lowerBoundTradeTime(frame.sourceAt);
      while (this.trades[frameTradeCursor] && this.trades[frameTradeCursor].time < tradeCutoff) {
        const trade = this.trades[frameTradeCursor];
        const impactedSide = trade.side === "sell" ? "bid" : trade.side === "buy" ? "ask" : null;
        if (impactedSide) {
          const bucket = Math.round(trade.price / frame.bucketSize) * frame.bucketSize;
          const key = `${impactedSide}:${bucket.toFixed(8)}`;
          correlatedTrades.set(key, (correlatedTrades.get(key) ?? 0) + trade.notional);
        }
        frameTradeCursor += 1;
      }
      for (let offset = 0; offset < frame.buckets.length; offset += 3) {
        const price = frame.buckets[offset];
        const bidNotional = frame.buckets[offset + 1];
        const askNotional = frame.buckets[offset + 2];
        const total = Math.max(1, bidNotional + askNotional);
        const imbalance = (bidNotional - askNotional) / total;
        const addSide = (side: BookHeatmapSide, notional: number) => {
          if (notional <= 0) return;
          const key = `${frame.venue}:${side}:${price.toFixed(8)}`;
          currentKeys.add(key);
          const previousNotional = previous.get(key) ?? 0;
          const stackingNotional = Math.max(0, notional - previousNotional);
          const pullingNotional = Math.max(0, previousNotional - notional);
          const correlatedTradeNotional = correlatedTrades.get(`${side}:${price.toFixed(8)}`) ?? 0;
          const estimatedConsumedNotional = Math.min(pullingNotional, correlatedTradeNotional);
          const estimatedCancelledNotional = Math.max(0, pullingNotional - estimatedConsumedNotional);
          const prior = lifecycle.get(key);
          const state = prior ?? { firstSeenAt: frame.sourceAt, observations: 0, peakNotional: 0, priorPulling: 0 };
          state.observations += 1;
          state.peakNotional = Math.max(state.peakNotional, notional);
          const replenishmentScore = state.priorPulling > 0
            ? Math.min(1, stackingNotional / Math.max(1, state.priorPulling))
            : 0;
          const absorptionScore = Math.min(1, correlatedTradeNotional / Math.max(1, notional + pullingNotional));
          const icebergProbability = replenishmentScore * Math.min(1, state.observations / 4) * (correlatedTradeNotional > 0 ? 1 : 0.55);
          state.priorPulling = pullingNotional;
          lifecycle.set(key, state);
          previous.set(key, notional);

          if (!emitFrame || xEndIndex < firstIndex || xStartIndex > lastIndex + 1 || price < priceMin || price > priceMax) return;
          const persistenceMs = Math.max(0, (next?.sourceAt ?? frame.sourceAt) - state.firstSeenAt);
          const transientScale = Math.max(1, state.peakNotional);
          const spoofRisk = persistenceMs < 3_000 && pullingNotional / transientScale > 0.55
            ? Math.min(1, pullingNotional / transientScale)
            : 0;
          result.push(this.makeRawCell({
            xStartIndex, xEndIndex, price, bucketSize: frame.bucketSize, side, notional,
            peakNotional: state.peakNotional, observations: state.observations, firstSeenAt: state.firstSeenAt,
            lastSeenAt: next?.sourceAt ?? frame.sourceAt, classification: "LIVE L2",
            venues: { [frame.venue]: { bidNotional: side === "bid" ? notional : 0, askNotional: side === "ask" ? notional : 0 } },
            stackingNotional, pullingNotional, imbalance, replenishmentScore, spoofRisk,
            correlatedTradeNotional, estimatedConsumedNotional, estimatedCancelledNotional,
            absorptionScore, icebergProbability
          }));
        };
        addSide("bid", bidNotional);
        addSide("ask", askNotional);
      }
      for (const key of previous.keys()) {
        if (key.startsWith(`${frame.venue}:`) && !currentKeys.has(key)) {
          previous.delete(key);
          lifecycle.delete(key);
        }
      }
    }
    return result;
  }

  private historicalCellsForView(firstIndex: number, lastIndex: number, priceMin: number, priceMax: number): RawCell[] {
    const result: RawCell[] = [];
    for (const cell of this.historicalCells) {
      if (cell.price < priceMin || cell.price > priceMax) continue;
      const { firstSeenAt, lastSeenAt, xStartIndex, xEndIndex } = cell;
      if (xEndIndex < firstIndex || xStartIndex > lastIndex + 1) continue;
      const venues = this.mapHistoricalVenues(cell);
      if (cell.bidSize > 0) result.push(this.makeRawCell({
        xStartIndex, xEndIndex, price: cell.price, bucketSize: cell.bucketSize, side: "bid",
        notional: cell.bidSize, peakNotional: Math.max(cell.bidSize, cell.bidPeakSize ?? 0),
        observations: Math.max(1, cell.observations ?? 1), firstSeenAt, lastSeenAt,
        classification: "HISTORICAL L2", venues,
        stackingNotional: 0, pullingNotional: 0,
        imbalance: (cell.bidSize - cell.askSize) / Math.max(1, cell.bidSize + cell.askSize),
        replenishmentScore: 0, spoofRisk: 0, correlatedTradeNotional: 0,
        estimatedConsumedNotional: 0, estimatedCancelledNotional: 0, absorptionScore: 0, icebergProbability: 0
      }));
      if (cell.askSize > 0) result.push(this.makeRawCell({
        xStartIndex, xEndIndex, price: cell.price, bucketSize: cell.bucketSize, side: "ask",
        notional: cell.askSize, peakNotional: Math.max(cell.askSize, cell.askPeakSize ?? 0),
        observations: Math.max(1, cell.observations ?? 1), firstSeenAt, lastSeenAt,
        classification: "HISTORICAL L2", venues,
        stackingNotional: 0, pullingNotional: 0,
        imbalance: (cell.bidSize - cell.askSize) / Math.max(1, cell.bidSize + cell.askSize),
        replenishmentScore: 0, spoofRisk: 0, correlatedTradeNotional: 0,
        estimatedConsumedNotional: 0, estimatedCancelledNotional: 0, absorptionScore: 0, icebergProbability: 0
      }));
    }
    return result;
  }

  private makeRawCell(input: {
    xStartIndex: number; xEndIndex: number; price: number; bucketSize: number; side: BookHeatmapSide;
    notional: number; peakNotional: number; observations: number; firstSeenAt: number; lastSeenAt: number;
    classification: BookHeatmapClassification; venues: Record<string, BookHeatmapVenueContribution>;
    stackingNotional: number; pullingNotional: number; imbalance: number; replenishmentScore: number; spoofRisk: number;
    correlatedTradeNotional: number; estimatedConsumedNotional: number; estimatedCancelledNotional: number;
    absorptionScore: number; icebergProbability: number;
  }): RawCell {
    const persistenceMs = Math.max(0, input.lastSeenAt - input.firstSeenAt);
    const persistenceWeight = 1 + Math.min(0.35, Math.log1p(input.observations) * 0.06 + Math.log1p(persistenceMs / 1000) * 0.025);
    return {
      xStartIndex: input.xStartIndex,
      xEndIndex: input.xEndIndex,
      price: input.price,
      priceLow: input.price - input.bucketSize * 0.5,
      priceHigh: input.price + input.bucketSize * 0.5,
      side: input.side,
      notional: input.notional,
      peakNotional: input.peakNotional,
      observations: input.observations,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      persistenceMs,
      stackingNotional: input.stackingNotional,
      pullingNotional: input.pullingNotional,
      imbalance: input.imbalance,
      replenishmentScore: input.replenishmentScore,
      spoofRisk: input.spoofRisk,
      correlatedTradeNotional: input.correlatedTradeNotional,
      estimatedConsumedNotional: input.estimatedConsumedNotional,
      estimatedCancelledNotional: input.estimatedCancelledNotional,
      absorptionScore: input.absorptionScore,
      icebergProbability: input.icebergProbability,
      confidence: Math.min(1, 0.42 + Math.log1p(input.observations) * 0.12 + Math.log1p(persistenceMs / 1000) * 0.035),
      analyticsBasis: input.classification === "LIVE L2" ? "OBSERVED BOOK DELTAS" : "HISTORICAL DEPTH TILES",
      classification: input.classification,
      venues: input.venues,
      score: Math.max(input.notional, input.peakNotional) * persistenceWeight
    };
  }

  private mapHistoricalVenues(cell: HistoricalBookHeatmapCell) {
    const venues: Record<string, BookHeatmapVenueContribution> = {};
    for (const [venue, contribution] of Object.entries(cell.venues ?? {})) {
      venues[venue] = {
        bidNotional: Math.max(0, Number(contribution.bidSize) || 0),
        askNotional: Math.max(0, Number(contribution.askSize) || 0)
      };
    }
    return venues;
  }

  private indexHistoricalCell(cell: HistoricalBookHeatmapCell): IndexedHistoricalCell {
    const firstSeenAt = toEpochMs(cell.time);
    const lastSeenAt = Math.max(firstSeenAt, toEpochMs(cell.bucketEnd ?? cell.time));
    return {
      ...cell,
      firstSeenAt,
      lastSeenAt,
      xStartIndex: this.indexForTime(firstSeenAt),
      xEndIndex: this.indexForTime(lastSeenAt)
    };
  }

  private reindexHistoricalCells() {
    this.historicalCells = this.historicalCells.map((cell) => ({
      ...cell,
      xStartIndex: this.indexForTime(cell.firstSeenAt),
      xEndIndex: this.indexForTime(cell.lastSeenAt)
    }));
  }

  private normalizeStrength(score: number, reference: number, maximum: number) {
    if (!finitePositive(score)) return 0;
    if (this.settings.scaleMode === "linear") return Math.min(1, score / Math.max(1, maximum));
    if (this.settings.scaleMode === "logarithmic") return Math.min(1, Math.log1p(score) / Math.max(1, Math.log1p(reference)));
    const ratio = score / Math.max(1, reference);
    if (this.settings.scaleMode === "percentile") return Math.min(1, Math.sqrt(ratio));
    return Math.min(1, Math.pow(ratio, 0.58));
  }

  private indexForTime(epochMs: number) {
    if (this.candles.length <= 1) return 0;
    const time = epochMs / 1000;
    let low = 0;
    let high = this.candles.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if ((this.candles[mid]?.time ?? Number.POSITIVE_INFINITY) <= time) low = mid + 1;
      else high = mid - 1;
    }
    const index = Math.max(0, Math.min(this.candles.length - 1, high));
    const current = this.candles[index];
    const next = this.candles[index + 1];
    const previous = this.candles[index - 1];
    const fallbackStep = Math.max(1, (current?.time ?? 0) - (previous?.time ?? 0));
    const step = Math.max(1, (next?.time ?? ((current?.time ?? time) + fallbackStep)) - (current?.time ?? time));
    const fraction = current ? Math.max(0, Math.min(1.2, (time - current.time) / step)) : 0;
    return index + fraction;
  }
}
