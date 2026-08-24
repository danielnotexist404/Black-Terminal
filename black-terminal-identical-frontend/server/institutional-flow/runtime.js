const NASDAQ_BASE_URL = "https://api.nasdaq.com/api/quote";
const REQUEST_TIMEOUT_MS = 8_000;
const LIVE_CACHE_TTL_MS = 30_000;
const MAX_STALE_MS = 15 * 60_000;

const FUND_UNIVERSES = Object.freeze({
  BTC: Object.freeze([
    fund("IBIT", "BlackRock", "iShares Bitcoin Trust ETF", true),
    fund("FBTC", "Fidelity", "Fidelity Wise Origin Bitcoin Fund", true),
    fund("GBTC", "Grayscale", "Grayscale Bitcoin Trust ETF", true),
    fund("ARKB", "ARK / 21Shares", "ARK 21Shares Bitcoin ETF"),
    fund("BITB", "Bitwise", "Bitwise Bitcoin ETF"),
    fund("BTCO", "Invesco Galaxy", "Invesco Galaxy Bitcoin ETF"),
    fund("HODL", "VanEck", "VanEck Bitcoin ETF"),
    fund("EZBC", "Franklin Templeton", "Franklin Bitcoin ETF")
  ]),
  ETH: Object.freeze([
    fund("ETHA", "BlackRock", "iShares Ethereum Trust ETF", true),
    fund("FETH", "Fidelity", "Fidelity Ethereum Fund", true),
    fund("ETHE", "Grayscale", "Grayscale Ethereum Trust ETF", true),
    fund("ETHW", "Bitwise", "Bitwise Ethereum ETF"),
    fund("CETH", "21Shares", "21Shares Core Ethereum ETF"),
    fund("EZET", "Franklin Templeton", "Franklin Ethereum ETF")
  ])
});

const cache = new Map();
const inflight = new Map();

export async function getInstitutionalFlowSnapshot(input = {}) {
  const asset = normalizeAsset(input.asset);
  const now = Number(input.now || Date.now());
  const cached = cache.get(asset);
  if (cached && now - cached.fetchedAt <= LIVE_CACHE_TTL_MS) return cached.payload;

  if (inflight.has(asset)) return inflight.get(asset);
  const request = buildInstitutionalFlowSnapshot(asset, input.fetchImpl || fetch, now)
    .then((payload) => {
      cache.set(asset, { fetchedAt: now, payload });
      return payload;
    })
    .catch((error) => {
      if (cached && now - cached.fetchedAt <= MAX_STALE_MS) {
        return {
          ...cached.payload,
          state: "stale",
          staleReason: publicFailure(error),
          ageMs: Math.max(0, now - cached.fetchedAt)
        };
      }
      throw error;
    })
    .finally(() => inflight.delete(asset));
  inflight.set(asset, request);
  return request;
}

export async function buildInstitutionalFlowSnapshot(asset, fetchImpl, now = Date.now()) {
  const universe = FUND_UNIVERSES[normalizeAsset(asset)] || [];
  if (universe.length === 0) return unsupportedSnapshot(asset, now);

  const settled = await Promise.allSettled(universe.map((definition) => loadFund(definition, fetchImpl)));
  const funds = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((value) => value.lastPrice > 0 && value.aumUsd > 0);

  if (funds.length === 0) {
    const error = new Error("Institutional market-data sources are temporarily unavailable.");
    error.statusCode = 503;
    error.code = "INSTITUTIONAL_FLOW_SOURCE_UNAVAILABLE";
    throw error;
  }

  const failures = settled.length - funds.length;
  const totalAumUsd = funds.reduce((sum, item) => sum + item.aumUsd, 0);
  const totalTurnoverUsd = funds.reduce((sum, item) => sum + item.turnoverUsd, 0);
  const signedTurnoverUsd = funds.reduce((sum, item) => sum + item.signedTurnoverUsd, 0);
  const pressureScore = weightedAverage(funds, (item) => item.pressureScore, (item) => item.aumUsd);
  const positiveFunds = funds.filter((item) => item.percentChange > 0).length;
  const negativeFunds = funds.filter((item) => item.percentChange < 0).length;
  const breadthPct = funds.length ? ((positiveFunds - negativeFunds) / funds.length) * 100 : 0;
  const oscillator = buildBasketOscillator(funds);
  const marketStatuses = [...new Set(funds.map((item) => item.marketStatus).filter(Boolean))];

  return {
    version: 1,
    asset: normalizeAsset(asset),
    state: failures > 0 ? "degraded" : "live",
    generatedAt: now,
    ageMs: 0,
    reporting: {
      primaryFlowCadence: "END_OF_DAY_OR_ISSUER_UPDATE",
      primaryFlowStatus: "NOT_CONFIGURED",
      reportedNetFlowUsd: null,
      livePressureCadence: "NASDAQ_REAL_TIME_OR_DELAYED",
      livePressureIsPrimaryFlow: false
    },
    basket: {
      pressureScore: round(pressureScore, 2),
      breadthPct: round(breadthPct, 2),
      positiveFunds,
      negativeFunds,
      totalFunds: funds.length,
      totalAumUsd: round(totalAumUsd, 0),
      totalTurnoverUsd: round(totalTurnoverUsd, 0),
      signedTurnoverUsd: round(signedTurnoverUsd, 0),
      marketStatus: marketStatuses.join(" / ") || "UNKNOWN"
    },
    funds: funds.map(stripInternalFundFields),
    oscillator,
    disclosures: {
      treasury: [{
        company: "Strategy",
        symbol: "MSTR",
        classification: "CORPORATE_BITCOIN_TREASURY",
        cadence: "PERIODIC_8_K",
        liveFlowAvailable: false,
        sourceUrl: "https://www.strategy.com/press"
      }],
      exclusions: [{
        manager: "Vanguard",
        reason: "NO_NATIVE_SPOT_CRYPTO_FUND",
        includedInBasket: false
      }]
    },
    methodology: {
      pressure: "AUM-weighted signed return, scaled by bounded square-root relative volume; range -100 to +100.",
      turnover: "Secondary-market share volume multiplied by last price. Signed turnover is a pressure proxy, not fund inflow/outflow.",
      primaryFlow: "Reserved for issuer-reported shares outstanding or creations/redemptions. Never inferred from exchange volume.",
      sources: [
        "https://api.nasdaq.com/api/quote/{ticker}/info?assetclass=etf",
        "https://api.nasdaq.com/api/quote/{ticker}/summary?assetclass=etf",
        "https://api.nasdaq.com/api/quote/{ticker}/chart?assetclass=etf"
      ]
    },
    sourceFailures: failures
  };
}

export function calculateFundPressure(percentChange, relativeVolume) {
  const signedReturn = finite(percentChange);
  const boundedRelativeVolume = clamp(finite(relativeVolume, 1), 0.05, 5);
  const volumeGain = 0.65 + 0.35 * Math.sqrt(boundedRelativeVolume);
  return clamp(100 * Math.tanh((signedReturn / 1.2) * volumeGain), -100, 100);
}

export function buildBasketOscillator(funds) {
  const chartFunds = funds.filter((item) => item.chart.length > 1 && item.previousClose > 0);
  if (chartFunds.length === 0) {
    const current = weightedAverage(funds, (item) => item.pressureScore, (item) => item.aumUsd);
    return [{ time: Date.now(), pressure: round(current, 2), signal: round(current, 2) }];
  }

  const timestamps = [...new Set(chartFunds.flatMap((item) => item.chart.map((point) => point.time)))].sort((a, b) => a - b);
  const latestByTicker = new Map();
  let signal = 0;
  const points = [];
  for (const timestamp of timestamps) {
    for (const item of chartFunds) {
      const point = item.chartByTime.get(timestamp);
      if (point) latestByTicker.set(item.ticker, point.price);
    }
    const visible = chartFunds.filter((item) => latestByTicker.has(item.ticker));
    if (visible.length < Math.min(2, chartFunds.length)) continue;
    const pressure = weightedAverage(
      visible,
      (item) => calculateFundPressure(((latestByTicker.get(item.ticker) / item.previousClose) - 1) * 100, item.relativeVolume),
      (item) => item.aumUsd
    );
    signal = points.length === 0 ? pressure : signal + (2 / 8) * (pressure - signal);
    points.push({ time: timestamp, pressure: round(pressure, 2), signal: round(signal, 2) });
  }
  return downsample(points, 96);
}

async function loadFund(definition, fetchImpl) {
  const [info, summary, chart] = await Promise.all([
    nasdaqJson(fetchImpl, definition.ticker, "info"),
    nasdaqJson(fetchImpl, definition.ticker, "summary"),
    definition.chart ? nasdaqJson(fetchImpl, definition.ticker, "chart").catch(() => null) : Promise.resolve(null)
  ]);
  const primary = info?.data?.primaryData || info?.data?.secondaryData || {};
  const secondary = info?.data?.secondaryData || {};
  const summaryData = summary?.data?.summaryData || {};
  const lastPrice = money(primary.lastSalePrice);
  const percentChange = percentage(primary.percentageChange);
  const volume = numeric(primary.volume || summaryData.ShareVolume?.value);
  const avgVolume20d = numeric(summaryData.AvgDailyVol20Days?.value);
  const aumUsd = numeric(summaryData.AUM?.value) * 1_000;
  const previousClose = money(summaryData.PreviousClose?.value || secondary.lastSalePrice);
  const relativeVolume = avgVolume20d > 0 ? volume / avgVolume20d : 1;
  const pressureScore = calculateFundPressure(percentChange, relativeVolume);
  const turnoverUsd = lastPrice * volume;
  const chartPoints = Array.isArray(chart?.data?.chart)
    ? chart.data.chart.map((point) => ({ time: numeric(point?.x), price: numeric(point?.y) })).filter((point) => point.time > 0 && point.price > 0)
    : [];

  return {
    ...definition,
    lastPrice,
    previousClose,
    percentChange,
    volume,
    avgVolume20d,
    relativeVolume,
    aumUsd,
    turnoverUsd,
    signedTurnoverUsd: turnoverUsd * Math.tanh(percentChange / 1.5),
    pressureScore,
    bidPrice: money(primary.bidPrice),
    askPrice: money(primary.askPrice),
    sourceTimestamp: String(primary.lastTradeTimestamp || chart?.data?.timeAsOf || ""),
    isRealTime: Boolean(primary.isRealTime),
    marketStatus: String(info?.data?.marketStatus || "UNKNOWN"),
    chart: chartPoints,
    chartByTime: new Map(chartPoints.map((point) => [point.time, point]))
  };
}

async function nasdaqJson(fetchImpl, ticker, action) {
  const response = await fetchImpl(`${NASDAQ_BASE_URL}/${ticker}/${action}?assetclass=etf`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": "Mozilla/5.0 (compatible; BlackTerminal-InstitutionalFlow/1.0)"
    }
  });
  if (!response.ok) throw sourceError(`${ticker} ${action} returned ${response.status}.`);
  const payload = await response.json();
  if (!payload?.data || Number(payload?.status?.rCode || 200) >= 400) throw sourceError(`${ticker} ${action} returned no market data.`);
  return payload;
}

function stripInternalFundFields(item) {
  return {
    ticker: item.ticker,
    manager: item.manager,
    name: item.name,
    classification: "SPOT_CRYPTO_ETP",
    lastPrice: round(item.lastPrice, 4),
    percentChange: round(item.percentChange, 3),
    volume: round(item.volume, 0),
    avgVolume20d: round(item.avgVolume20d, 0),
    relativeVolume: round(item.relativeVolume, 3),
    aumUsd: round(item.aumUsd, 0),
    turnoverUsd: round(item.turnoverUsd, 0),
    signedTurnoverUsd: round(item.signedTurnoverUsd, 0),
    pressureScore: round(item.pressureScore, 2),
    bidPrice: round(item.bidPrice, 4),
    askPrice: round(item.askPrice, 4),
    sourceTimestamp: item.sourceTimestamp,
    isRealTime: item.isRealTime,
    sourceUrl: `https://www.nasdaq.com/market-activity/etf/${item.ticker.toLowerCase()}`
  };
}

function unsupportedSnapshot(asset, now) {
  return {
    version: 1,
    asset: normalizeAsset(asset),
    state: "unsupported",
    generatedAt: now,
    ageMs: 0,
    reporting: { primaryFlowStatus: "NO_US_SPOT_ETP_BASKET", reportedNetFlowUsd: null, livePressureIsPrimaryFlow: false },
    basket: null,
    funds: [],
    oscillator: [],
    disclosures: { treasury: [], exclusions: [] },
    methodology: { primaryFlow: "No supported U.S. spot ETP basket exists for this chart asset." },
    sourceFailures: 0
  };
}

function fund(ticker, manager, name, chart = false) {
  return Object.freeze({ ticker, manager, name, chart });
}

function normalizeAsset(value) {
  return String(value || "BTC").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "BTC";
}

function money(value) {
  return numeric(String(value || "").replace(/[$%]/g, ""));
}

function percentage(value) {
  return numeric(String(value || "").replace(/[$%+]/g, ""));
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9+.\-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function weightedAverage(items, value, weight) {
  const denominator = items.reduce((sum, item) => sum + Math.max(0, finite(weight(item))), 0);
  if (denominator <= 0) return 0;
  return items.reduce((sum, item) => sum + finite(value(item)) * Math.max(0, finite(weight(item))), 0) / denominator;
}

function downsample(points, maximum) {
  if (points.length <= maximum) return points;
  const output = [];
  const stride = (points.length - 1) / (maximum - 1);
  for (let index = 0; index < maximum; index += 1) output.push(points[Math.round(index * stride)]);
  return output;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
}

function sourceError(message) {
  const error = new Error(message);
  error.statusCode = 502;
  error.code = "INSTITUTIONAL_FLOW_UPSTREAM_ERROR";
  return error;
}

function publicFailure(error) {
  return error?.code || "INSTITUTIONAL_FLOW_REFRESH_FAILED";
}

export const institutionalFlowInternals = Object.freeze({
  FUND_UNIVERSES,
  LIVE_CACHE_TTL_MS,
  MAX_STALE_MS
});
