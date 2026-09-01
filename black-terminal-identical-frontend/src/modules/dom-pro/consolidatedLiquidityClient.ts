import { useEffect, useMemo, useRef, useState } from "react";
import { isLocalOnlyRuntime } from "../../core/local-runtime/localRuntimeClient";
import { supabase } from "../../lib/supabase";
import { blackCoreMarketDataEngine } from "../../market-data/engine/marketDataEngine";
import type { ExchangeId, MarketSymbol, OrderBookSnapshot } from "../../market-data/types";
import { assessConsolidatedLiquiditySnapshot, shouldRetainPreviousConsolidatedSnapshot } from "./consolidatedLiquidityState";

export type ConsolidatedLiquidityVenue = {
  venue: string;
  marketKind: string;
  exchangeSymbol: string;
  bidLevels: number;
  askLevels: number;
  coverageMin: number | null;
  coverageMax: number | null;
  sourceTimestamp: number | null;
  receivedAt: number | null;
  transport: string;
  status: string;
};

export type ConsolidatedLiquidityRow = {
  index: number;
  priceHigh: number;
  priceLow: number;
  price: number;
  bidBase: number;
  askBase: number;
  bidNotionalUsd: number;
  askNotionalUsd: number;
  bidCumulativeUsd: number;
  askCumulativeUsd: number;
  deltaNotionalUsd: number;
  venueCount: number;
  coverageVenueCount: number;
  contributions: Array<{
    venue: string;
    bidBase: number;
    askBase: number;
    bidNotionalUsd: number;
    askNotionalUsd: number;
  }>;
};

export type ConsolidatedLiquiditySnapshot = {
  schemaVersion: number;
  source: "black-core-consolidated-liquidity-fabric" | "black-terminal-local-liquidity-fabric";
  state: "live" | "degraded" | "initializing";
  generatedAt: number;
  baseAsset: string;
  quoteAsset: "USD";
  referencePrice: number | null;
  viewport: { minimumPrice: number; maximumPrice: number; rowCount: number; step: number };
  rows: ConsolidatedLiquidityRow[];
  includedVenues: ConsolidatedLiquidityVenue[];
  excludedVenues: Array<{ venue: string | null; reasons: string[] }>;
  sourceLevels: number;
  coverageRatio: number;
};

export type ConsolidatedLiquidityFeed = {
  snapshot: ConsolidatedLiquiditySnapshot | null;
  book: OrderBookSnapshot | null;
  status: "loading" | "live" | "degraded" | "error";
  error: string | null;
  lastSuccessfulAt: number | null;
};

type FeedInput = {
  baseAsset: string;
  minimumPrice: number;
  maximumPrice: number;
  rowCount: number;
  priceStep: number;
  enabled?: boolean;
};

const POLL_INTERVAL_MS = 850;
const LOCAL_POLL_INTERVAL_MS = 2_000;
const VIEWPORT_SETTLE_MS = 120;
const latestSuccessfulByAsset = new Map<string, ConsolidatedLiquidityFeed>();

export function useConsolidatedLiquidityFeed(input: FeedInput): ConsolidatedLiquidityFeed {
  const enabled = input.enabled !== false && validViewport(input);
  const requestKey = useMemo(() => [
    input.baseAsset.toUpperCase(),
    roundedKey(input.minimumPrice),
    roundedKey(input.maximumPrice),
    Math.round(input.rowCount),
    roundedKey(input.priceStep)
  ].join(":"), [input.baseAsset, input.maximumPrice, input.minimumPrice, input.priceStep, input.rowCount]);
  const [feed, setFeed] = useState<ConsolidatedLiquidityFeed>(() => latestSuccessfulByAsset.get(input.baseAsset.toUpperCase())
    ?? { snapshot: null, book: null, status: "loading", error: null, lastSuccessfulAt: null });
  const latestSuccessfulRef = useRef<ConsolidatedLiquidityFeed | null>(latestSuccessfulByAsset.get(input.baseAsset.toUpperCase()) ?? null);
  const latestAssetRef = useRef(input.baseAsset.toUpperCase());

  useEffect(() => {
    if (!enabled) return;
    const requestedAsset = input.baseAsset.toUpperCase();
    if (latestAssetRef.current !== requestedAsset) {
      latestAssetRef.current = requestedAsset;
      latestSuccessfulRef.current = latestSuccessfulByAsset.get(requestedAsset) ?? null;
      setFeed(latestSuccessfulRef.current ?? { snapshot: null, book: null, status: "loading", error: null, lastSuccessfulAt: null });
    }
    let stopped = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const snapshot = await fetchConsolidatedLiquidity(input, controller.signal);
        if (stopped) return;
        const prior = latestSuccessfulRef.current ?? latestSuccessfulByAsset.get(requestedAsset) ?? null;
        const quality = assessConsolidatedLiquiditySnapshot(snapshot);
        if (!quality.populated || shouldRetainPreviousConsolidatedSnapshot(prior?.snapshot, snapshot)) {
          const reason = quality.populated
            ? "Consolidated depth coverage regressed; retaining the last verified wide frame."
            : "Consolidated depth refresh contained no populated authoritative rows."
          setFeed(prior
            ? { ...prior, status: "degraded", error: reason }
            : { snapshot: null, book: null, status: snapshot.state === "initializing" ? "loading" : "degraded", error: reason, lastSuccessfulAt: null });
          return;
        }
        const next: ConsolidatedLiquidityFeed = {
          snapshot,
          book: toOrderBook(snapshot),
          status: snapshot.state === "live" ? "live" : "degraded",
          error: null,
          lastSuccessfulAt: Date.now()
        };
        latestSuccessfulRef.current = next;
        latestSuccessfulByAsset.set(requestedAsset, next);
        if (latestSuccessfulByAsset.size > 8) latestSuccessfulByAsset.delete(latestSuccessfulByAsset.keys().next().value!);
        setFeed(next);
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        const prior = latestSuccessfulRef.current;
        setFeed({
          snapshot: prior?.snapshot ?? null,
          book: prior?.book ?? null,
          status: prior ? "degraded" : "error",
          error: error instanceof Error ? error.message : String(error),
          lastSuccessfulAt: prior?.lastSuccessfulAt ?? null
        });
      } finally {
        if (!stopped) timer = window.setTimeout(poll, isLocalOnlyRuntime() ? LOCAL_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
      }
    };

    setFeed((current) => ({ ...current, status: current.snapshot ? "degraded" : "loading", error: null }));
    timer = window.setTimeout(poll, VIEWPORT_SETTLE_MS);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [requestKey, enabled]);

  return feed;
}

async function fetchConsolidatedLiquidity(input: FeedInput, signal: AbortSignal): Promise<ConsolidatedLiquiditySnapshot> {
  if (isLocalOnlyRuntime()) return fetchLocalConsolidatedLiquidity(input);
  const session = supabase ? await supabase.auth.getSession() : null;
  const token = session?.data.session?.access_token;
  if (!token) throw new Error("Authenticated liquidity access is unavailable.");
  const parameters = new URLSearchParams({
    baseAsset: input.baseAsset.toUpperCase(),
    minimumPrice: String(input.minimumPrice),
    maximumPrice: String(input.maximumPrice),
    rowCount: String(Math.max(8, Math.min(240, Math.round(input.rowCount)))),
    priceStep: String(input.priceStep)
  });
  const response = await fetch(`/api/market-depth/consolidated?${parameters.toString()}`, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(payload?.error || payload?.message || `Consolidated depth request failed (${response.status}).`));
  return validateSnapshot(payload);
}

type LocalVenue = { exchange: ExchangeId; label: string; rawSymbol: string };

async function fetchLocalConsolidatedLiquidity(input: FeedInput): Promise<ConsolidatedLiquiditySnapshot> {
  const baseAsset = input.baseAsset.toUpperCase();
  const venues: LocalVenue[] = [
    { exchange: "bybit", label: "BYBIT", rawSymbol: `${baseAsset}USDT` },
    { exchange: "binance", label: "BINANCE", rawSymbol: `${baseAsset}USDT` },
    { exchange: "okx", label: "OKX", rawSymbol: `${baseAsset}-USDT-SWAP` }
  ];
  const settled = await Promise.allSettled(venues.map(async (venue) => {
    const symbol: MarketSymbol = {
      exchange: venue.exchange,
      rawSymbol: venue.rawSymbol,
      baseAsset,
      quoteAsset: "USDT",
      marketKind: "perpetual"
    };
    const adapter = blackCoreMarketDataEngine.getAdapter(venue.exchange);
    if (!adapter.getOrderBookSnapshot) throw new Error("ORDER_BOOK_UNSUPPORTED");
    const book = await adapter.getOrderBookSnapshot(symbol, 400);
    if (!book?.bids.length || !book.asks.length) throw new Error("ORDER_BOOK_EMPTY");
    return { venue, book };
  }));
  const available = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const excludedVenues = settled.flatMap((result, index) => result.status === "rejected"
    ? [{ venue: venues[index]!.label, reasons: [safeLocalVenueError(result.reason)] }]
    : []);
  const minimumPrice = input.minimumPrice;
  const maximumPrice = input.maximumPrice;
  const rowCount = Math.max(8, Math.min(240, Math.round(input.rowCount)));
  const step = (maximumPrice - minimumPrice) / rowCount;
  const rows: ConsolidatedLiquidityRow[] = Array.from({ length: rowCount }, (_, index) => ({
    index,
    priceLow: minimumPrice + index * step,
    priceHigh: minimumPrice + (index + 1) * step,
    price: minimumPrice + (index + 0.5) * step,
    bidBase: 0,
    askBase: 0,
    bidNotionalUsd: 0,
    askNotionalUsd: 0,
    bidCumulativeUsd: 0,
    askCumulativeUsd: 0,
    deltaNotionalUsd: 0,
    venueCount: 0,
    coverageVenueCount: 0,
    contributions: []
  }));
  let sourceLevels = 0;
  let coveredSpan = 0;
  const mids: number[] = [];
  const includedVenues: ConsolidatedLiquidityVenue[] = [];
  for (const { venue, book } of available) {
    const levels = [...book.bids, ...book.asks].filter((level) => Number.isFinite(level.price) && Number.isFinite(level.quantity) && level.price > 0 && level.quantity > 0);
    sourceLevels += levels.length;
    const prices = levels.map((level) => level.price);
    const coverageMin = prices.length ? Math.min(...prices) : null;
    const coverageMax = prices.length ? Math.max(...prices) : null;
    if (coverageMin !== null && coverageMax !== null) {
      coveredSpan += Math.max(0, Math.min(maximumPrice, coverageMax) - Math.max(minimumPrice, coverageMin));
    }
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid && ask) mids.push((bid + ask) / 2);
    includedVenues.push({
      venue: venue.label,
      marketKind: "perpetual",
      exchangeSymbol: venue.rawSymbol,
      bidLevels: book.bids.length,
      askLevels: book.asks.length,
      coverageMin,
      coverageMax,
      sourceTimestamp: book.time,
      receivedAt: Date.now(),
      transport: "LOCAL_PUBLIC_REST",
      status: "LIVE"
    });
    const contributions = new Map<number, { bidBase: number; askBase: number; bidNotionalUsd: number; askNotionalUsd: number }>();
    const accumulate = (side: "bid" | "ask", price: number, quantity: number) => {
      if (price < minimumPrice || price > maximumPrice) return;
      const index = Math.min(rowCount - 1, Math.max(0, Math.floor((price - minimumPrice) / step)));
      const row = rows[index]!;
      const current = contributions.get(index) || { bidBase: 0, askBase: 0, bidNotionalUsd: 0, askNotionalUsd: 0 };
      if (side === "bid") {
        row.bidBase += quantity;
        row.bidNotionalUsd += quantity * price;
        current.bidBase += quantity;
        current.bidNotionalUsd += quantity * price;
      } else {
        row.askBase += quantity;
        row.askNotionalUsd += quantity * price;
        current.askBase += quantity;
        current.askNotionalUsd += quantity * price;
      }
      contributions.set(index, current);
    };
    book.bids.forEach((level) => accumulate("bid", level.price, level.quantity));
    book.asks.forEach((level) => accumulate("ask", level.price, level.quantity));
    for (const [index, contribution] of contributions) {
      rows[index]!.contributions.push({ venue: venue.label, ...contribution });
    }
  }
  let bidCumulativeUsd = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    bidCumulativeUsd += rows[index]!.bidNotionalUsd;
    rows[index]!.bidCumulativeUsd = bidCumulativeUsd;
  }
  let askCumulativeUsd = 0;
  for (const row of rows) {
    askCumulativeUsd += row.askNotionalUsd;
    row.askCumulativeUsd = askCumulativeUsd;
    row.deltaNotionalUsd = row.bidNotionalUsd - row.askNotionalUsd;
    row.venueCount = row.contributions.length;
    row.coverageVenueCount = available.filter(({ book }) => {
      const prices = [...book.bids, ...book.asks].map((level) => level.price);
      return prices.length > 0 && Math.min(...prices) <= row.priceHigh && Math.max(...prices) >= row.priceLow;
    }).length;
  }
  mids.sort((left, right) => left - right);
  const referencePrice = mids.length ? mids[Math.floor(mids.length / 2)]! : null;
  const requestedSpan = Math.max(Number.EPSILON, maximumPrice - minimumPrice);
  const coverageRatio = available.length ? Math.min(1, coveredSpan / (requestedSpan * available.length)) : 0;
  return {
    schemaVersion: 1,
    source: "black-terminal-local-liquidity-fabric",
    state: available.length >= 2 ? "live" : available.length === 1 ? "degraded" : "initializing",
    generatedAt: Date.now(),
    baseAsset,
    quoteAsset: "USD",
    referencePrice,
    viewport: { minimumPrice, maximumPrice, rowCount, step },
    rows,
    includedVenues,
    excludedVenues,
    sourceLevels,
    coverageRatio
  };
}

function safeLocalVenueError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[^A-Za-z0-9:_ .-]/g, "").slice(0, 120) || "LOCAL_VENUE_UNAVAILABLE";
}

function toOrderBook(snapshot: ConsolidatedLiquiditySnapshot): OrderBookSnapshot {
  return {
    exchange: "composite",
    symbol: `${snapshot.baseAsset}-CLF`,
    time: snapshot.generatedAt,
    bids: snapshot.rows.filter((row) => row.bidBase > 0).map((row) => ({ price: row.price, quantity: row.bidBase })),
    asks: snapshot.rows.filter((row) => row.askBase > 0).map((row) => ({ price: row.price, quantity: row.askBase })),
    priceStep: snapshot.viewport.step,
    subscribedDepth: snapshot.sourceLevels,
    sequence: snapshot.generatedAt
  };
}

function validateSnapshot(value: unknown): ConsolidatedLiquiditySnapshot {
  const snapshot = value as ConsolidatedLiquiditySnapshot;
  if (!snapshot || !["black-core-consolidated-liquidity-fabric", "black-terminal-local-liquidity-fabric"].includes(snapshot.source) || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.includedVenues)) {
    throw new Error("Consolidated depth response failed its data contract.");
  }
  return snapshot;
}

function validViewport(input: FeedInput) {
  return /^[A-Z0-9]{2,15}$/i.test(input.baseAsset)
    && Number.isFinite(input.minimumPrice)
    && Number.isFinite(input.maximumPrice)
    && input.minimumPrice > 0
    && input.maximumPrice > input.minimumPrice
    && Number.isFinite(input.priceStep)
    && input.priceStep > 0;
}

function roundedKey(value: number) {
  return Number.isFinite(value) ? value.toPrecision(9) : "invalid";
}
