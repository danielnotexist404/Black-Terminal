import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { OrderBookSnapshot } from "../../market-data/types";

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
  source: "black-core-consolidated-liquidity-fabric";
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
  enabled?: boolean;
};

const POLL_INTERVAL_MS = 850;
const VIEWPORT_SETTLE_MS = 120;

export function useConsolidatedLiquidityFeed(input: FeedInput): ConsolidatedLiquidityFeed {
  const enabled = input.enabled !== false && validViewport(input);
  const requestKey = useMemo(() => [
    input.baseAsset.toUpperCase(),
    roundedKey(input.minimumPrice),
    roundedKey(input.maximumPrice),
    Math.round(input.rowCount)
  ].join(":"), [input.baseAsset, input.maximumPrice, input.minimumPrice, input.rowCount]);
  const [feed, setFeed] = useState<ConsolidatedLiquidityFeed>({ snapshot: null, book: null, status: "loading", error: null, lastSuccessfulAt: null });
  const latestSuccessfulRef = useRef<ConsolidatedLiquidityFeed | null>(null);
  const latestAssetRef = useRef(input.baseAsset.toUpperCase());

  useEffect(() => {
    if (!enabled) return;
    const requestedAsset = input.baseAsset.toUpperCase();
    if (latestAssetRef.current !== requestedAsset) {
      latestAssetRef.current = requestedAsset;
      latestSuccessfulRef.current = null;
      setFeed({ snapshot: null, book: null, status: "loading", error: null, lastSuccessfulAt: null });
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
        const next: ConsolidatedLiquidityFeed = {
          snapshot,
          book: toOrderBook(snapshot),
          status: snapshot.state === "live" ? "live" : "degraded",
          error: null,
          lastSuccessfulAt: Date.now()
        };
        latestSuccessfulRef.current = next;
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
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
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
  const session = supabase ? await supabase.auth.getSession() : null;
  const token = session?.data.session?.access_token;
  if (!token) throw new Error("Authenticated liquidity access is unavailable.");
  const parameters = new URLSearchParams({
    baseAsset: input.baseAsset.toUpperCase(),
    minimumPrice: String(input.minimumPrice),
    maximumPrice: String(input.maximumPrice),
    rowCount: String(Math.max(8, Math.min(240, Math.round(input.rowCount))))
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

function toOrderBook(snapshot: ConsolidatedLiquiditySnapshot): OrderBookSnapshot {
  return {
    exchange: "composite",
    symbol: `${snapshot.baseAsset}-CLF`,
    time: snapshot.generatedAt,
    bids: snapshot.rows.filter((row) => row.bidBase > 0).map((row) => ({ price: row.price, quantity: row.bidBase })),
    asks: snapshot.rows.filter((row) => row.askBase > 0).map((row) => ({ price: row.price, quantity: row.askBase })),
    subscribedDepth: snapshot.sourceLevels,
    sequence: snapshot.generatedAt
  };
}

function validateSnapshot(value: unknown): ConsolidatedLiquiditySnapshot {
  const snapshot = value as ConsolidatedLiquiditySnapshot;
  if (!snapshot || snapshot.source !== "black-core-consolidated-liquidity-fabric" || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.includedVenues)) {
    throw new Error("Consolidated depth response failed its data contract.");
  }
  return snapshot;
}

function validViewport(input: FeedInput) {
  return /^[A-Z0-9]{2,15}$/i.test(input.baseAsset)
    && Number.isFinite(input.minimumPrice)
    && Number.isFinite(input.maximumPrice)
    && input.minimumPrice > 0
    && input.maximumPrice > input.minimumPrice;
}

function roundedKey(value: number) {
  return Number.isFinite(value) ? value.toPrecision(9) : "invalid";
}
