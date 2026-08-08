import type { Candle } from "../../../chart-engine/types.ts";
import { marketDataFetchJson } from "../../../market-data/transport.ts";
import { buildCohortEntryDistribution } from "../core/entryDistribution.ts";
import { BCLIF_BROWSER_OI_INTERVAL, liquidationHorizonMs } from "../core/settings.ts";
import type {
  LiquidationCoverage,
  LiquidationFieldSettings,
  LiquidationInstrumentRules,
  LiquidationMarketFrame,
  LiquidationRiskTier
} from "../core/types.ts";
import { BCLIF_SOURCE_VERSION } from "../core/types.ts";

const BYBIT_REST = "https://api.bybit.com";

type BybitEnvelope<T> = { retCode: number; retMsg: string; result: T; time: number };
type OiResult = { list: Array<{ openInterest: string; singleOpenInterest?: string; timestamp: string }>; nextPageCursor?: string };
type RiskResult = { list: Array<{ id: number; riskLimitValue: string; maintenanceMargin: string; initialMargin: string; maxLeverage: string; mmDeduction: string }> };
type TickerResult = { list: Array<{ lastPrice: string; markPrice: string; indexPrice: string; openInterest: string; singleOpenInterest?: string; fundingRate?: string; bid1Price?: string; ask1Price?: string }> };
type AccountRatioResult = { list: Array<{ buyRatio: string; sellRatio: string; timestamp: string }> };
type FundingResult = { list: Array<{ fundingRate: string; fundingRateTimestamp: string }> };
type KlineResult = { list: Array<[string, string, string, string, string, string, string]> };
type InstrumentResult = { list: Array<{ priceFilter?: { tickSize?: string } }> };

async function bybitGet<T>(path: string, params: URLSearchParams, signal?: AbortSignal) {
  const payload = await marketDataFetchJson<BybitEnvelope<T>>(`${BYBIT_REST}${path}?${params}`, { signal });
  if (payload.retCode !== 0) throw new Error(`Bybit ${path} failed (${payload.retCode}): ${payload.retMsg}`);
  return payload.result;
}

async function fetchBybitOiHistory(params: URLSearchParams, signal?: AbortSignal): Promise<OiResult> {
  const list: OiResult["list"] = [];
  let cursor = "";
  const seen = new Set<string>();
  for (let page = 0; page < 200; page++) {
    const pageParams = new URLSearchParams(params);
    if (cursor) pageParams.set("cursor", cursor);
    const result = await bybitGet<OiResult>("/v5/market/open-interest", pageParams, signal);
    list.push(...result.list);
    const next = result.nextPageCursor ?? "";
    if (!next || seen.has(next) || result.list.length === 0) break;
    seen.add(next);
    cursor = next;
  }
  return { list };
}

async function fetchBybitCanonicalKlines(symbol: string, startTime: number, endTime: number, signal?: AbortSignal) {
  const rows: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number; turnover: number }> = [];
  let cursorEnd = endTime;
  for (let page = 0; page < 100 && cursorEnd >= startTime; page += 1) {
    const result = await bybitGet<KlineResult>("/v5/market/kline", new URLSearchParams({
      category: "linear",
      symbol,
      interval: "5",
      start: String(startTime),
      end: String(cursorEnd),
      limit: "1000"
    }), signal);
    if (!result.list?.length) break;
    let earliest = Infinity;
    for (const row of result.list) {
      const time = finite(row[0]);
      earliest = Math.min(earliest, time);
      rows.push({
        time,
        open: finite(row[1]),
        high: finite(row[2]),
        low: finite(row[3]),
        close: finite(row[4]),
        volume: finite(row[5]),
        turnover: finite(row[6])
      });
    }
    if (!Number.isFinite(earliest) || earliest <= startTime) break;
    cursorEnd = earliest - 1;
    if (page === 99) throw new Error("Bybit canonical kline history exceeded pagination safety bound");
  }
  const unique = new Map<number, (typeof rows)[number]>();
  for (const row of rows) if (row.time >= startTime && row.time <= endTime && row.close > 0) unique.set(row.time, row);
  return [...unique.values()].sort((left, right) => left.time - right.time);
}

function candlesInOiInterval<T extends { time: number }>(candles: readonly T[], startExclusive: number, endInclusive: number) {
  const firstAfter = (timestamp: number) => {
    let low = 0;
    let high = candles.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candles[middle]!.time <= timestamp) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return candles.slice(firstAfter(startExclusive), firstAfter(endInclusive));
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rate(value: unknown, fallback: number) {
  const number = finite(value, fallback);
  return number > 0.2 ? number / 100 : number;
}

export function fallbackBybitRules(symbol: string): LiquidationInstrumentRules {
  return {
    venue: "BYBIT",
    symbol,
    contractType: "USDT_LINEAR_PERPETUAL",
    contractMultiplier: 1,
    maxLeverage: 100,
    leverageStep: 0.01,
    fundingIntervalMinutes: 480,
    riskTiers: [{
      tierId: "fallback-1",
      riskLimitValue: 2_000_000,
      maintenanceMarginRate: 0.005,
      initialMarginRate: 0.01,
      maintenanceMarginDeduction: 0,
      maxLeverage: 100,
      certainty: "ESTIMATED_MEDIUM"
    }],
    fetchedAt: Date.now(),
    sourceVersion: BCLIF_SOURCE_VERSION,
    certainty: "ESTIMATED_MEDIUM"
  };
}

export async function fetchBybitRiskRules(symbol: string, signal?: AbortSignal): Promise<LiquidationInstrumentRules> {
  try {
    const result = await bybitGet<RiskResult>("/v5/market/risk-limit", new URLSearchParams({ category: "linear", symbol }), signal);
    const riskTiers: LiquidationRiskTier[] = result.list.map((item) => ({
      tierId: String(item.id),
      riskLimitValue: finite(item.riskLimitValue),
      maintenanceMarginRate: rate(item.maintenanceMargin, 0.005),
      initialMarginRate: rate(item.initialMargin, 0.01),
      maintenanceMarginDeduction: finite(item.mmDeduction),
      maxLeverage: finite(item.maxLeverage, 100),
      certainty: "OBSERVED" as const
    })).filter((tier) => tier.riskLimitValue > 0 && tier.maintenanceMarginRate > 0);
    if (!riskTiers.length) return fallbackBybitRules(symbol);
    return {
      ...fallbackBybitRules(symbol),
      riskTiers,
      maxLeverage: Math.max(...riskTiers.map((tier) => tier.maxLeverage)),
      certainty: "OBSERVED"
    };
  } catch (error) {
    console.warn("BCLIF risk-tier request failed; using explicitly estimated fallback", error);
    return fallbackBybitRules(symbol);
  }
}

export interface BybitLiquidationBootstrap {
  frames: LiquidationMarketFrame[];
  rules: LiquidationInstrumentRules;
  coverage: LiquidationCoverage;
}

export async function bootstrapBybitLiquidationField(
  _sourceCandles: readonly Candle[],
  rawSymbol: string,
  settings: LiquidationFieldSettings,
  signal?: AbortSignal
): Promise<BybitLiquidationBootstrap> {
  const symbol = rawSymbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const requestedEnd = Date.now();
  const requestedStart = requestedEnd - liquidationHorizonMs(settings);
  const oiParams = new URLSearchParams({
    category: "linear",
    symbol,
    // The inventory clock is fixed and does not inherit chart timeframe or
    // presentation horizon. Horizon selects only the requested span.
    intervalTime: BCLIF_BROWSER_OI_INTERVAL,
    startTime: String(requestedStart),
    endTime: String(requestedEnd),
    limit: "200"
  });
  const tickerParams = new URLSearchParams({ category: "linear", symbol });
  const ratioParams = new URLSearchParams({
    category: "linear", symbol,
    period: "1h",
    limit: "500"
  });
  const fundingParams = new URLSearchParams({
    category: "linear", symbol,
    startTime: String(requestedStart), endTime: String(requestedEnd), limit: "200"
  });
  const [rules, oiResult, tickerResult, ratioResult, fundingResult, canonicalKlines, instrumentResult] = await Promise.all([
    fetchBybitRiskRules(symbol, signal),
    fetchBybitOiHistory(oiParams, signal).catch(() => ({ list: [] })),
    bybitGet<TickerResult>("/v5/market/tickers", tickerParams, signal).catch(() => ({ list: [] })),
    bybitGet<AccountRatioResult>("/v5/market/account-ratio", ratioParams, signal).catch(() => ({ list: [] })),
    bybitGet<FundingResult>("/v5/market/funding/history", fundingParams, signal).catch(() => ({ list: [] })),
    fetchBybitCanonicalKlines(symbol, requestedStart, requestedEnd, signal),
    bybitGet<InstrumentResult>("/v5/market/instruments-info", new URLSearchParams({ category: "linear", symbol }), signal).catch(() => ({ list: [] }))
  ]);
  const tickSize = finite(instrumentResult.list[0]?.priceFilter?.tickSize, 0);
  if (tickSize > 0) rules.tickSize = tickSize;
  const ticker = tickerResult.list[0];
  const oiPoints = oiResult.list.map((item) => ({
    timestamp: finite(item.timestamp),
    // Current Bybit exposes singleOpenInterest. Older responses expose the
    // both-sides sum, so halve it rather than doubling the modeled position base.
    value: item.singleOpenInterest != null ? finite(item.singleOpenInterest) : finite(item.openInterest) * 0.5
  })).filter((point) => point.timestamp > 0 && point.value > 0).sort((a, b) => a.timestamp - b.timestamp);
  const ratioPoints = ratioResult.list.map((item) => ({
    timestamp: finite(item.timestamp), long: finite(item.buyRatio), short: finite(item.sellRatio)
  })).filter((point) => point.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp);
  const fundingPoints = fundingResult.list.map((item) => ({
    timestamp: finite(item.fundingRateTimestamp), rate: finite(item.fundingRate)
  })).filter((point) => point.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp);

  const candles = canonicalKlines;
  if (!candles.length) throw new Error("Canonical 5-minute Bybit history is unavailable; chart candles are not allowed to define BCLIF inventory");
  let oiIndex = 0;
  let ratioIndex = 0;
  let fundingIndex = 0;
  let consumedOi: { timestamp: number; value: number } | null = null;
  let mappedOiFrames = 0;
  const returns: number[] = [];
  const frames: LiquidationMarketFrame[] = [];
  let runningCvd = 0;

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!;
    const timestamp = candle.time;
    while (oiIndex + 1 < oiPoints.length && oiPoints[oiIndex + 1]!.timestamp <= timestamp) oiIndex += 1;
    while (ratioIndex + 1 < ratioPoints.length && ratioPoints[ratioIndex + 1]!.timestamp <= timestamp) ratioIndex += 1;
    while (fundingIndex + 1 < fundingPoints.length && fundingPoints[fundingIndex + 1]!.timestamp <= timestamp) fundingIndex += 1;
    const point = oiPoints[oiIndex];
    const ratioPoint = ratioPoints[ratioIndex];
    const fundingPoint = fundingPoints[fundingIndex];
    let openInterest = point && point.timestamp <= timestamp ? point.value : 0;
    if (!openInterest && index === candles.length - 1 && ticker) {
      openInterest = ticker.singleOpenInterest != null ? finite(ticker.singleOpenInterest) : finite(ticker.openInterest) * 0.5;
    }
    if (openInterest > 0) mappedOiFrames += 1;
    const previous = candles[index - 1];
    const logReturn = previous?.close && candle.close > 0 ? Math.log(candle.close / previous.close) : 0;
    returns.push(logReturn);
    if (returns.length > 24) returns.shift();
    const mean = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length);
    const realizedVolatility = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length));
    const parkinsonVolatility = candle.low > 0 ? Math.sqrt(Math.max(0, Math.log(candle.high / candle.low) ** 2 / (4 * Math.log(2)))) : 0;
    const markPrice = index === candles.length - 1 && ticker ? finite(ticker.markPrice, candle.close) : candle.close;
    const indexPrice = index === candles.length - 1 && ticker ? finite(ticker.indexPrice, markPrice) : markPrice;
    const bestBid = index === candles.length - 1 && ticker ? finite(ticker.bid1Price, markPrice) : markPrice;
    const bestAsk = index === candles.length - 1 && ticker ? finite(ticker.ask1Price, markPrice) : markPrice;
    const advancedOi = Boolean(point && point.timestamp <= timestamp && (!consumedOi || point.timestamp > consumedOi.timestamp));
    const openInterestDelta = advancedOi && consumedOi && openInterest > 0 ? openInterest - consumedOi.value : 0;
    const oiIntervalStart = advancedOi && consumedOi ? consumedOi.timestamp : undefined;
    const oiIntervalEnd = advancedOi && consumedOi ? point!.timestamp : undefined;
    const intervalCandles = oiIntervalStart !== undefined && oiIntervalEnd !== undefined
      ? candlesInOiInterval(candles, oiIntervalStart, oiIntervalEnd)
      : [];
    const entryDistribution = openInterestDelta > 0 && oiIntervalStart !== undefined && oiIntervalEnd !== undefined
      ? buildCohortEntryDistribution({
          observations: intervalCandles.flatMap((candidate) => {
            const weight = candidate.turnover > 0 ? candidate.turnover : candidate.volume * candidate.close;
            return [
              { price: candidate.low, weight: weight * 0.18 },
              { price: (candidate.high + candidate.low + candidate.close) / 3, weight: weight * 0.64 },
              { price: candidate.high, weight: weight * 0.18 }
            ];
          }),
          source: "LOWER_TF_APPROXIMATION",
          intervalStart: oiIntervalStart,
          intervalEnd: oiIntervalEnd,
          confidence: 0.58,
          fallbackPrice: markPrice,
          maximumRows: 7
        })
      : undefined;
    if (advancedOi && point) consumedOi = { timestamp: point.timestamp, value: point.value };
    // Historical aggressor flow is intentionally left unavailable. Candle
    // direction is not silently relabeled as real CVD.
    runningCvd += 0;
    frames.push({
      venue: "BYBIT",
      symbol,
      timestamp,
      lastPrice: candle.close,
      markPrice,
      indexPrice,
      basisBps: indexPrice ? ((markPrice - indexPrice) / indexPrice) * 10_000 : 0,
      openInterest,
      openInterestDelta,
      oiIntervalStart,
      oiIntervalEnd,
      entryDistribution,
      fundingRate: fundingPoint?.timestamp <= timestamp
        ? fundingPoint.rate
        : index === candles.length - 1 && ticker?.fundingRate != null ? finite(ticker.fundingRate) : null,
      longAccountRatio: ratioPoint?.timestamp <= timestamp ? ratioPoint.long : null,
      shortAccountRatio: ratioPoint?.timestamp <= timestamp ? ratioPoint.short : null,
      aggressiveBuyNotional: 0,
      aggressiveSellNotional: 0,
      cvd: runningCvd,
      cvdEfficiency: 0,
      realizedVolatility,
      parkinsonVolatility,
      bestBid,
      bestAsk,
      spreadBps: markPrice ? Math.max(0, ((bestAsk - bestBid) / markPrice) * 10_000) : 0,
      bidDepthCurve: { points: [], certainty: "UNAVAILABLE" },
      askDepthCurve: { points: [], certainty: "UNAVAILABLE" },
      confirmedLongLiquidations: 0,
      confirmedShortLiquidations: 0,
      certainty: {
        trades: "UNAVAILABLE",
        openInterest: openInterest > 0 ? "OBSERVED" : "UNAVAILABLE",
        entryPrice: "ESTIMATED_LOW",
        leveragePrior: settings.modelPreset === "VENUE_CALIBRATED" ? "ESTIMATED_HIGH" : "ESTIMATED_MEDIUM",
        marginModel: "ESTIMATED_LOW",
        confirmedLiquidations: "UNAVAILABLE",
        continuity: openInterest > 0 ? "DERIVED" : "UNAVAILABLE",
        orderbook: "UNAVAILABLE"
      },
      sourceVersion: BCLIF_SOURCE_VERSION
    });
  }

  const availableStart = oiPoints[0]?.timestamp ?? null;
  const availableEnd = oiPoints.at(-1)?.timestamp ?? null;
  const oiCoverage = frames.length ? mappedOiFrames / frames.length * 100 : 0;
  const coverage: LiquidationCoverage = {
    venue: "BYBIT",
    symbol,
    horizon: settings.horizon,
    requestedStart,
    requestedEnd,
    availableStart,
    availableEnd,
    observedTradeCoveragePercent: 0,
    openInterestCoveragePercent: oiCoverage,
    liquidationEventCoveragePercent: 0,
    orderbookCoveragePercent: 0,
    modelContinuityPercent: oiCoverage,
    missingIntervals: availableStart && availableStart > requestedStart ? [{ start: requestedStart, end: availableStart }] : [],
    quality: oiCoverage >= 85 ? "MIXED" : oiCoverage >= 45 ? "LOW" : "INSUFFICIENT",
    state: frames.length && oiCoverage > 0 ? "COLLECTING" : "UNAVAILABLE"
  };
  return { frames, rules, coverage };
}
