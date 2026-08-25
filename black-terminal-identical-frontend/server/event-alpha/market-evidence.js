import { isIP } from "node:net";

const BYBIT_PUBLIC_API = "https://api.bybit.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class BybitPublicMarketEvidence {
  constructor(configuration = {}, fetchImpl = globalThis.fetch, clock = () => new Date()) {
    this.baseUrl = configuration.baseUrl || BYBIT_PUBLIC_API;
    this.timeoutMs = boundedInteger(configuration.timeoutMs ?? 10_000, 1_000, 30_000);
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    assertBybitUrl(this.baseUrl);
  }

  static fromEnvironment(env = process.env, fetchImpl = globalThis.fetch, clock) {
    return new BybitPublicMarketEvidence({
      baseUrl: env.EVENT_ALPHA_BYBIT_PUBLIC_API_URL || BYBIT_PUBLIC_API,
      timeoutMs: env.EVENT_ALPHA_SOURCE_TIMEOUT_MS
    }, fetchImpl, clock);
  }

  async context({ symbol, eventTime, benchmarkSymbol = "BTCUSDT", signal }) {
    const cutoffAt = this.clock().toISOString();
    const [assetTicker, benchmarkTicker, assetEventPrice, benchmarkEventPrice] = await Promise.all([
      this.ticker(symbol, signal),
      symbol === benchmarkSymbol ? null : this.ticker(benchmarkSymbol, signal),
      this.priceAt(symbol, eventTime, signal),
      symbol === benchmarkSymbol ? null : this.priceAt(benchmarkSymbol, eventTime, signal)
    ]);
    const benchmark = benchmarkTicker || assetTicker;
    const benchmarkStart = benchmarkEventPrice ?? assetEventPrice;
    if (!assetTicker || !assetEventPrice || !benchmark || !benchmarkStart) throw marketError("EVENT_ALPHA_MARKET_EVIDENCE_INCOMPLETE", "Public market evidence is unavailable for the event window.");
    return Object.freeze({
      symbol,
      benchmarkSymbol,
      cutoffAt,
      currentPrice: assetTicker.lastPrice,
      eventPrice: assetEventPrice,
      realizedAssetReturnBps: returnBps(assetTicker.lastPrice, assetEventPrice),
      realizedBenchmarkReturnBps: returnBps(benchmark.lastPrice, benchmarkStart),
      averageDailyDollarVolume: assetTicker.turnover24h,
      sourceManifest: {
        provider: "BYBIT_PUBLIC_V5",
        endpointClass: "PUBLIC_MARKET_DATA",
        evidenceCutoffAt: cutoffAt,
        eventTime: new Date(eventTime).toISOString(),
        noPrivateCredentials: true
      }
    });
  }

  async ticker(symbol, signal) {
    const url = this.url("/v5/market/tickers", { category: "linear", symbol: normalizeSymbol(symbol) });
    const body = await this.fetchJson(url, signal);
    const row = body?.result?.list?.[0];
    const lastPrice = positive(row?.lastPrice);
    const turnover24h = positive(row?.turnover24h);
    if (!lastPrice || !turnover24h) throw marketError("EVENT_ALPHA_MARKET_TICKER_INVALID", "Bybit ticker evidence is incomplete.");
    return { lastPrice, turnover24h };
  }

  async priceAt(symbol, eventTime, signal) {
    const eventMs = Date.parse(eventTime);
    if (!Number.isFinite(eventMs)) throw marketError("EVENT_ALPHA_MARKET_EVENT_TIME_INVALID", "Event time is invalid.");
    const ageDays = Math.max(0, (this.clock().getTime() - eventMs) / 86_400_000);
    const interval = ageDays > 30 ? "D" : ageDays > 7 ? "240" : "60";
    const intervalMs = interval === "D" ? 86_400_000 : Number(interval) * 60_000;
    const url = this.url("/v5/market/kline", {
      category: "linear",
      symbol: normalizeSymbol(symbol),
      interval,
      start: String(Math.max(0, eventMs - intervalMs)),
      end: String(Math.min(this.clock().getTime(), eventMs + intervalMs * 2)),
      limit: "10"
    });
    const body = await this.fetchJson(url, signal);
    const rows = Array.isArray(body?.result?.list) ? body.result.list : [];
    const candidates = rows.map((row) => ({ timestamp: Number(row?.[0]), close: positive(row?.[4]) })).filter((row) => Number.isFinite(row.timestamp) && row.close);
    candidates.sort((a, b) => Math.abs(a.timestamp - eventMs) - Math.abs(b.timestamp - eventMs));
    return candidates[0]?.close || null;
  }

  url(path, parameters) {
    const base = assertBybitUrl(this.baseUrl);
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url;
  }

  async fetchJson(url, signal) {
    assertBybitUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("MARKET_TIMEOUT")), this.timeoutMs);
    const relay = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relay, { once: true });
    try {
      const response = await this.fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw marketError(`EVENT_ALPHA_MARKET_HTTP_${response.status}`, "Bybit public market request failed.");
      if (!String(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) throw marketError("EVENT_ALPHA_MARKET_CONTENT_TYPE_INVALID", "Bybit public market response was not JSON.");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw marketError("EVENT_ALPHA_MARKET_RESPONSE_TOO_LARGE", "Bybit public market response exceeded two MiB.");
      const body = JSON.parse(text);
      if (Number(body?.retCode) !== 0) throw marketError(`EVENT_ALPHA_MARKET_BYBIT_${String(body?.retCode || "UNKNOWN").slice(0, 20)}`, "Bybit rejected the public market request.");
      return body;
    } catch (error) {
      if (error?.code) throw error;
      throw marketError("EVENT_ALPHA_MARKET_REQUEST_FAILED", "Public market evidence could not be collected.", error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
  }
}

function assertBybitUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || isIP(host) || !new Set(["api.bybit.com", "api.bytick.com"]).has(host)) {
    throw marketError("EVENT_ALPHA_MARKET_HOST_NOT_ALLOWED", "Market evidence URL is not allowlisted.");
  }
  return url;
}

function normalizeSymbol(value) {
  const symbol = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{2,36}USDT$/.test(symbol)) throw marketError("EVENT_ALPHA_MARKET_SYMBOL_INVALID", "Market evidence symbol is invalid.");
  return symbol;
}

function positive(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
function returnBps(current, start) { return ((current / start) - 1) * 10_000; }
function boundedInteger(value, minimum, maximum) { const parsed = Math.round(Number(value)); return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : minimum)); }
function marketError(code, message, cause) { const error = new Error(message); error.code = code; error.cause = cause; return error; }
