import type { ConfirmedLiquidationEvent, LiquidationMarketFrame } from "../../../src/modules/liquidation-field/core/types.ts";
import { buildCohortEntryDistribution } from "../../../src/modules/liquidation-field/core/entryDistribution.ts";
import type { BclifBookFrame, BclifCanonicalEvent, BclifFrameEnvelope, BclifOpenInterestPoint, PersistentLiquidationEvent, PersistentPublicTrade } from "../contracts.ts";

export interface BclifTickerContext {
  exchangeTimestamp: number;
  receivedTimestamp: number;
  lastPrice: number;
  markPrice: number;
  indexPrice: number;
  basisBps: number;
  singleSideOpenInterest: number;
  fundingRate: number | null;
  bestBid: number;
  bestAsk: number;
}

export interface BclifRatioContext {
  timestamp: number;
  receivedTimestamp: number;
  longAccountRatio: number;
  shortAccountRatio: number;
}

/**
 * Decide whether one live OI observation advances the consumed cursor.
 * Reusing the same REST/ticker observation across many faster model frames
 * must produce a zero delta; otherwise a single OI change creates cohorts on
 * every frame until the next poll.
 */
export function consumeOpenInterestObservation(
  current: BclifOpenInterestPoint | null,
  consumed: BclifOpenInterestPoint | null
) {
  if (!current) return { current: null, previous: null, nextConsumed: consumed, advanced: false };
  if (current.availabilityMode !== "LIVE_OBSERVATION") throw new Error("Only a live OI observation may advance the consumed cursor");
  if (!consumed) return { current, previous: current, nextConsumed: current, advanced: true };
  const ordering = current.availableAt - consumed.availableAt || current.timestamp - consumed.timestamp;
  if (ordering === 0) {
    if (current.singleSideOpenInterest !== consumed.singleSideOpenInterest) throw new Error("BCLIF OI observation identity changed value");
    return { current, previous: current, nextConsumed: consumed, advanced: false };
  }
  if (ordering < 0) return { current, previous: current, nextConsumed: consumed, advanced: false };
  return { current, previous: consumed, nextConsumed: current, advanced: true };
}

export function buildCanonicalFrame(input: {
  symbol: string;
  frameStart: number;
  frameEnd: number;
  sourceCutoffTimestamp: number;
  generatedAt?: number;
  sourceVersion: string;
  trades: readonly BclifCanonicalEvent<PersistentPublicTrade>[];
  liquidations: readonly BclifCanonicalEvent<PersistentLiquidationEvent>[];
  currentOpenInterest: BclifOpenInterestPoint | null;
  previousOpenInterest: BclifOpenInterestPoint | null;
  ticker: BclifTickerContext;
  ratio: BclifRatioContext | null;
  book: BclifBookFrame | null;
  sourceAvailability: { trades: boolean; liquidations: boolean; orderbook: boolean; openInterest: boolean; funding: boolean; positioning: boolean };
}): BclifFrameEnvelope {
  if (!(input.frameEnd > input.frameStart) || input.sourceCutoffTimestamp !== input.frameEnd) {
    throw new Error("Canonical BCLIF live frames require an exact as-of cutoff at frame end");
  }
  const trades = inside(input.trades, input.frameStart, input.frameEnd, input.sourceCutoffTimestamp);
  const liquidations = inside(input.liquidations, input.frameStart, input.frameEnd, input.sourceCutoffTimestamp);
  requireKnownAtOrBefore(input.ticker.exchangeTimestamp, input.ticker.receivedTimestamp, input.frameEnd, input.sourceCutoffTimestamp, "ticker");
  if (input.currentOpenInterest) requireKnownAtOrBefore(input.currentOpenInterest.timestamp, input.currentOpenInterest.receivedTimestamp, input.frameEnd, input.sourceCutoffTimestamp, "open interest");
  if (input.previousOpenInterest) requireKnownAtOrBefore(input.previousOpenInterest.timestamp, input.previousOpenInterest.receivedTimestamp, input.frameEnd, input.sourceCutoffTimestamp, "previous open interest");
  if (input.ratio) requireKnownAtOrBefore(input.ratio.timestamp, input.ratio.receivedTimestamp, input.frameEnd, input.sourceCutoffTimestamp, "account ratio");
  if (input.book) requireKnownAtOrBefore(input.book.exchangeTimestamp, input.book.receivedTimestamp, input.frameEnd, input.sourceCutoffTimestamp, "orderbook");
  const aggressiveBuyNotional = sum(trades.filter((event) => event.payload.aggressorSide === "BUY").map((event) => event.payload.notional));
  const aggressiveSellNotional = sum(trades.filter((event) => event.payload.aggressorSide === "SELL").map((event) => event.payload.notional));
  const prices = trades.map((event) => event.payload.price);
  const volatility = realizedVolatility(prices);
  const parkinson = parkinsonVolatility(prices);
  const book = input.book;
  const oi = input.currentOpenInterest?.singleSideOpenInterest ?? input.ticker.singleSideOpenInterest;
  const previousOi = input.previousOpenInterest?.singleSideOpenInterest ?? oi;
  const oiAdvanced = Boolean(input.currentOpenInterest && input.previousOpenInterest
    && (input.currentOpenInterest.availableAt > input.previousOpenInterest.availableAt
      || input.currentOpenInterest.timestamp > input.previousOpenInterest.timestamp));
  const oiIntervalStart = oiAdvanced ? input.previousOpenInterest!.timestamp : undefined;
  const oiIntervalEnd = oiAdvanced ? input.currentOpenInterest!.timestamp : undefined;
  const oiDelta = oi - previousOi;
  const entryTrades = oiIntervalStart !== undefined && oiIntervalEnd !== undefined
    ? inside(input.trades, oiIntervalStart, oiIntervalEnd, input.sourceCutoffTimestamp)
    : [];
  const entryDistribution = oiDelta > 0 && oiIntervalStart !== undefined && oiIntervalEnd !== undefined && oiIntervalEnd > oiIntervalStart
    ? buildCohortEntryDistribution({
        observations: entryTrades.map((event) => ({ price: event.payload.price, weight: event.payload.notional })),
        source: entryTrades.length ? "EXACT_TRADES" : "CHART_BAR_APPROXIMATION",
        intervalStart: oiIntervalStart,
        intervalEnd: oiIntervalEnd,
        confidence: entryTrades.length ? 0.94 : 0.28,
        fallbackPrice: input.ticker.markPrice,
        maximumRows: 7
      })
    : undefined;
  const frame: LiquidationMarketFrame = {
    venue: "BYBIT",
    symbol: input.symbol,
    timestamp: input.frameEnd,
    lastPrice: input.ticker.lastPrice,
    markPrice: input.ticker.markPrice,
    indexPrice: input.ticker.indexPrice,
    basisBps: input.ticker.basisBps,
    openInterest: oi,
    openInterestDelta: oiDelta,
    oiIntervalStart,
    oiIntervalEnd,
    entryDistribution,
    fundingRate: input.ticker.fundingRate,
    longAccountRatio: input.ratio?.longAccountRatio ?? null,
    shortAccountRatio: input.ratio?.shortAccountRatio ?? null,
    aggressiveBuyNotional,
    aggressiveSellNotional,
    cvd: aggressiveBuyNotional - aggressiveSellNotional,
    cvdEfficiency: aggressiveBuyNotional + aggressiveSellNotional > 0 ? Math.abs(aggressiveBuyNotional - aggressiveSellNotional) / (aggressiveBuyNotional + aggressiveSellNotional) : 0,
    realizedVolatility: volatility,
    parkinsonVolatility: parkinson,
    bestBid: book?.bestBid ?? input.ticker.bestBid,
    bestAsk: book?.bestAsk ?? input.ticker.bestAsk,
    spreadBps: book?.spreadBps ?? ((input.ticker.bestAsk - input.ticker.bestBid) / input.ticker.markPrice) * 10_000,
    bidDepthCurve: book ? depthCurve(book, "BID") : { points: [], certainty: "MISSING" },
    askDepthCurve: book ? depthCurve(book, "ASK") : { points: [], certainty: "MISSING" },
    confirmedLongLiquidations: sum(liquidations.filter((event) => event.payload.liquidatedSide === "LONG").map((event) => event.payload.estimatedNotional)),
    confirmedShortLiquidations: sum(liquidations.filter((event) => event.payload.liquidatedSide === "SHORT").map((event) => event.payload.estimatedNotional)),
    certainty: {
      trades: input.sourceAvailability.trades ? "OBSERVED" : "MISSING",
      openInterest: input.sourceAvailability.openInterest && input.currentOpenInterest ? "OBSERVED" : "MISSING",
      liquidations: input.sourceAvailability.liquidations ? "OBSERVED" : "MISSING",
      orderbook: input.sourceAvailability.orderbook && book ? "OBSERVED" : "MISSING",
      funding: input.sourceAvailability.funding && input.ticker.fundingRate !== null ? "OBSERVED" : "MISSING",
      markPrice: "OBSERVED",
      positioning: input.sourceAvailability.positioning && input.ratio ? "OBSERVED" : "MISSING",
      entryPrice: entryTrades.length ? "DERIVED" : oiDelta > 0 ? "ESTIMATED_LOW" : "MISSING",
      leveragePrior: "ESTIMATED_MEDIUM",
      marginModel: "ESTIMATED_LOW",
      confirmedLiquidations: input.sourceAvailability.liquidations ? "OBSERVED" : "MISSING",
      continuity: input.sourceAvailability.openInterest && input.currentOpenInterest && input.sourceAvailability.trades ? "DERIVED" : "MISSING"
    },
    sourceVersion: input.sourceVersion
  };
  return {
    frameStart: input.frameStart,
    frameEnd: input.frameEnd,
    sourceCutoffTimestamp: input.sourceCutoffTimestamp,
    generatedAt: input.generatedAt ?? Date.now(),
    authority: "PERSISTENT_NODE",
    freshness: {
      tradesAgeMs: newestAge(trades, input.sourceCutoffTimestamp),
      liquidationsAgeMs: newestAge(liquidations, input.sourceCutoffTimestamp),
      orderbookAgeMs: book ? Math.max(0, input.sourceCutoffTimestamp - book.exchangeTimestamp) : null,
      openInterestAgeMs: input.currentOpenInterest ? Math.max(0, input.sourceCutoffTimestamp - input.currentOpenInterest.timestamp) : null,
      fundingAgeMs: input.ticker.fundingRate === null ? null : Math.max(0, input.sourceCutoffTimestamp - input.ticker.exchangeTimestamp),
      markPriceAgeMs: Math.max(0, input.sourceCutoffTimestamp - input.ticker.exchangeTimestamp),
      riskTierAgeMs: null
    },
    frame
  };
}

export function confirmedEvent(event: BclifCanonicalEvent<PersistentLiquidationEvent>): ConfirmedLiquidationEvent {
  return {
    id: event.payload.id,
    venue: event.payload.venue,
    symbol: event.payload.symbol,
    timestamp: event.payload.exchangeTimestamp,
    receivedAt: event.payload.receivedTimestamp,
    liquidatedPositionSide: event.payload.liquidatedSide,
    quantity: event.payload.quantity,
    bankruptcyPrice: event.payload.bankruptcyPrice,
    notional: event.payload.estimatedNotional,
    certainty: "OBSERVED",
    sourceVersion: event.payload.sourceVersion
  };
}

function inside<T extends { exchangeTimestamp: number; receivedTimestamp: number }>(events: readonly T[], start: number, end: number, cutoff: number) {
  return events.filter((event) => event.exchangeTimestamp > start && event.exchangeTimestamp <= end && event.exchangeTimestamp <= cutoff && event.receivedTimestamp <= cutoff);
}
function requireKnownAtOrBefore(timestamp: number, receivedTimestamp: number, frameEnd: number, cutoff: number, label: string) { if (timestamp > frameEnd || receivedTimestamp > cutoff) throw new Error(`BCLIF ${label} uses future data`); }
function sum(values: readonly number[]) { return values.reduce((total, value) => total + value, 0); }
function newestAge(events: readonly { exchangeTimestamp: number }[], cutoff: number) { return events.length ? Math.max(0, cutoff - events.at(-1)!.exchangeTimestamp) : null; }
function realizedVolatility(prices: readonly number[]) {
  if (prices.length < 2) return 0;
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]!));
  const mean = sum(returns) / returns.length;
  return Math.sqrt(sum(returns.map((value) => (value - mean) ** 2)) / Math.max(1, returns.length - 1));
}
function parkinsonVolatility(prices: readonly number[]) {
  if (!prices.length) return 0;
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  return low > 0 ? Math.sqrt(Math.log(high / low) ** 2 / (4 * Math.log(2))) : 0;
}
function depthCurve(book: BclifBookFrame, side: "BID" | "ASK") {
  const levels = side === "BID" ? book.bids : book.asks;
  const points = levels.map((level) => ({
    distanceBps: Math.abs(level.price - book.midPrice) / book.midPrice * 10_000,
    notional: level.price * level.quantity
  }));
  return { points, certainty: "OBSERVED" as const };
}
