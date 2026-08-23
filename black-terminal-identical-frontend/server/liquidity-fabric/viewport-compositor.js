const EPSILON = 1e-12;

export function projectLiquidityViewport(input = {}) {
  const now = finitePositive(input.now ?? Date.now(), "now");
  const minimumPrice = finitePositive(input.minimumPrice, "minimumPrice");
  const maximumPrice = finitePositive(input.maximumPrice, "maximumPrice");
  if (maximumPrice <= minimumPrice) throw inputError("maximumPrice must exceed minimumPrice");
  const requestedRowCount = clampInteger(input.rowCount ?? 80, 8, 240);
  const baseAsset = token(input.baseAsset).toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(baseAsset)) throw inputError("baseAsset is invalid");
  const maximumAgeMs = clampInteger(input.maximumAgeMs ?? 15_000, 500, 60_000);
  const span = maximumPrice - minimumPrice;
  const requestedPriceStep = optionalFinitePositive(input.priceStep, "priceStep");
  const step = requestedPriceStep ?? span / requestedRowCount;
  const anchoredMinimumIndex = requestedPriceStep === null ? null : Math.ceil(minimumPrice / step - 0.5);
  const anchoredMaximumIndex = requestedPriceStep === null ? null : Math.floor(maximumPrice / step + 0.5);
  const rowCount = requestedPriceStep === null
    ? requestedRowCount
    : Math.max(0, Number(anchoredMaximumIndex) - Number(anchoredMinimumIndex) + 1);
  if (rowCount < 1 || rowCount > 240) throw inputError("priceStep must produce between 1 and 240 canonical rows");
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    index,
    priceHigh: anchoredMaximumIndex === null ? maximumPrice - index * step : (anchoredMaximumIndex - index + 0.5) * step,
    priceLow: anchoredMaximumIndex === null ? maximumPrice - (index + 1) * step : (anchoredMaximumIndex - index - 0.5) * step,
    price: anchoredMaximumIndex === null ? maximumPrice - (index + 0.5) * step : (anchoredMaximumIndex - index) * step,
    bidBase: 0,
    askBase: 0,
    bidNotionalUsd: 0,
    askNotionalUsd: 0,
    bidCumulativeUsd: 0,
    askCumulativeUsd: 0,
    venues: new Map(),
    coverageVenues: new Set()
  }));
  const included = [];
  const excluded = [];

  for (const book of Array.isArray(input.books) ? input.books : []) {
    const validation = validateBook(book, baseAsset, now, maximumAgeMs);
    if (!validation.ok) {
      excluded.push({ venue: token(book?.venue).toLowerCase() || null, reasons: validation.reasons });
      continue;
    }
    const venue = token(book.venue).toLowerCase();
    const coverageMin = book.bids.at(-1)?.price ?? null;
    const coverageMax = book.asks.at(-1)?.price ?? null;
    included.push({
      venue,
      marketKind: book.marketKind,
      exchangeSymbol: book.exchangeSymbol,
      bidLevels: book.bids.length,
      askLevels: book.asks.length,
      coverageMin,
      coverageMax,
      sourceTimestamp: book.sourceTimestamp,
      receivedAt: book.receivedAt,
      transport: book.transport,
      status: book.status,
      midPrice: midpoint(book)
    });
    if (coverageMin !== null && coverageMax !== null) {
      for (const row of rows) {
        if (row.priceHigh >= coverageMin && row.priceLow <= coverageMax) row.coverageVenues.add(venue);
      }
    }
    accumulateLevels(rows, book.bids, "bid", venue, minimumPrice, maximumPrice, step, anchoredMaximumIndex);
    accumulateLevels(rows, book.asks, "ask", venue, minimumPrice, maximumPrice, step, anchoredMaximumIndex);
  }

  const referencePrice = median(included.map((summary) => summary.midPrice).filter(Number.isFinite));
  const currentIndex = referencePrice === null
    ? Math.floor(rowCount / 2)
    : anchoredMaximumIndex === null
      ? clampInteger(Math.floor((maximumPrice - referencePrice) / step), 0, rowCount - 1)
      : clampInteger(anchoredMaximumIndex - Math.round(referencePrice / step), 0, rowCount - 1);

  let askCumulative = 0;
  for (let index = currentIndex; index >= 0; index -= 1) {
    askCumulative += rows[index].askNotionalUsd;
    rows[index].askCumulativeUsd = askCumulative;
  }
  let bidCumulative = 0;
  for (let index = currentIndex; index < rows.length; index += 1) {
    bidCumulative += rows[index].bidNotionalUsd;
    rows[index].bidCumulativeUsd = bidCumulative;
  }

  const previous = Array.isArray(input.previousRows) ? input.previousRows : [];
  const previousByPrice = new Map(previous.map((row) => [stablePriceKey(row?.price), row]));
  const finalizedRows = rows.map((row, index) => {
    const prior = previousByPrice.get(stablePriceKey(row.price));
    const deltaNotionalUsd = prior
      ? (row.bidNotionalUsd - Number(prior.bidNotionalUsd || 0)) - (row.askNotionalUsd - Number(prior.askNotionalUsd || 0))
      : 0;
    const contributions = [...row.venues.entries()]
      .map(([venue, value]) => ({ venue, ...value }))
      .sort((left, right) => (right.bidNotionalUsd + right.askNotionalUsd) - (left.bidNotionalUsd + left.askNotionalUsd));
    return Object.freeze({
      index: row.index,
      priceHigh: row.priceHigh,
      priceLow: row.priceLow,
      price: row.price,
      bidBase: row.bidBase,
      askBase: row.askBase,
      bidNotionalUsd: row.bidNotionalUsd,
      askNotionalUsd: row.askNotionalUsd,
      bidCumulativeUsd: row.bidCumulativeUsd,
      askCumulativeUsd: row.askCumulativeUsd,
      deltaNotionalUsd,
      venueCount: contributions.length,
      coverageVenueCount: row.coverageVenues.size,
      contributions: Object.freeze(contributions)
    });
  });
  const coveredRows = finalizedRows.filter((row) => row.coverageVenueCount > 0).length;
  const sourceLevels = included.reduce((total, venue) => total + venue.bidLevels + venue.askLevels, 0);

  return Object.freeze({
    schemaVersion: 1,
    source: "black-core-consolidated-liquidity-fabric",
    state: included.length >= 2 ? "live" : included.length === 1 ? "degraded" : "initializing",
    generatedAt: now,
    baseAsset,
    quoteAsset: "USD",
    referencePrice,
    viewport: Object.freeze({ minimumPrice, maximumPrice, rowCount, step }),
    rows: Object.freeze(finalizedRows),
    includedVenues: Object.freeze(included),
    excludedVenues: Object.freeze(excluded),
    sourceLevels,
    coverageRatio: coveredRows / rowCount,
    semantics: Object.freeze({
      scope: "GLOBAL_CROSS_MARKET_INFORMATIONAL",
      observedLiquidityOnly: true,
      syntheticLiquidityIncluded: false,
      hiddenLiquidityIncluded: false,
      rpiIncluded: false,
      stableQuoteNormalization: "USD_USDT_USDC_DISPLAY_PARITY",
      executionBook: false
    })
  });
}

function accumulateLevels(rows, levels, side, venue, minimumPrice, maximumPrice, step, anchoredMaximumIndex) {
  for (const level of levels) {
    const price = Number(level?.price);
    const quantity = Number(level?.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) continue;
    if (side === "bid" && price < minimumPrice) break;
    if (side === "ask" && price > maximumPrice) break;
    if (price < minimumPrice || price > maximumPrice) continue;
    const index = anchoredMaximumIndex === null
      ? clampInteger(Math.floor((maximumPrice - price) / step), 0, rows.length - 1)
      : clampInteger(anchoredMaximumIndex - Math.round(price / step), 0, rows.length - 1);
    const row = rows[index];
    const notional = price * quantity;
    if (side === "bid") {
      row.bidBase += quantity;
      row.bidNotionalUsd += notional;
    } else {
      row.askBase += quantity;
      row.askNotionalUsd += notional;
    }
    const contribution = row.venues.get(venue) ?? { bidBase: 0, askBase: 0, bidNotionalUsd: 0, askNotionalUsd: 0 };
    if (side === "bid") {
      contribution.bidBase += quantity;
      contribution.bidNotionalUsd += notional;
    } else {
      contribution.askBase += quantity;
      contribution.askNotionalUsd += notional;
    }
    row.venues.set(venue, contribution);
  }
}

function validateBook(book, baseAsset, now, maximumAgeMs) {
  const reasons = [];
  if (!book || typeof book !== "object") reasons.push("BOOK_MISSING");
  if (token(book?.baseAsset).toUpperCase() !== baseAsset) reasons.push("BASE_ASSET_MISMATCH");
  if (book?.status !== "HEALTHY") reasons.push(`BOOK_${book?.status || "MISSING"}`);
  if (!Array.isArray(book?.bids) || !book.bids.length || !Array.isArray(book?.asks) || !book.asks.length) reasons.push("EMPTY_SIDE");
  if (book?.direct !== true || book?.relabelled === true) reasons.push("UNVERIFIED_PROVENANCE");
  const receivedAt = Number(book?.receivedAt);
  if (!Number.isFinite(receivedAt) || now - receivedAt > maximumAgeMs) reasons.push("STALE_BOOK");
  const bestBid = Number(book?.bids?.[0]?.price);
  const bestAsk = Number(book?.asks?.[0]?.price);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid >= bestAsk) reasons.push("CROSSED_OR_INVALID_BOOK");
  return { ok: reasons.length === 0, reasons: Object.freeze(reasons) };
}

function midpoint(book) {
  const bid = Number(book?.bids?.[0]?.price);
  const ask = Number(book?.asks?.[0]?.price);
  return Number.isFinite(bid) && Number.isFinite(ask) && bid < ask ? (bid + ask) / 2 : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function finitePositive(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw inputError(`${label} is invalid`);
  return numeric;
}

function optionalFinitePositive(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return finitePositive(value, label);
}

function stablePriceKey(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toPrecision(12) : "invalid";
}

function inputError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "LIQUIDITY_FABRIC_INPUT_INVALID" });
}

function token(value) { return String(value ?? "").trim(); }
function clampInteger(value, min, max) { return Math.min(max, Math.max(min, Math.floor(Number(value) || min))); }
