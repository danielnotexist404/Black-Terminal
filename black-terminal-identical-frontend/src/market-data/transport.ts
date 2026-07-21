import { publicMarketGet } from "../lib/tauri";

const DEV_PROXY_ROUTES: Record<string, string> = {
  "https://api.binance.com": "/market-proxy/binance-spot",
  "https://fapi.binance.com": "/market-proxy/binance-usdm",
  "https://api.bybit.com": "/market-proxy/bybit",
  "https://www.okx.com": "/market-proxy/okx"
};

class MarketDataHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Market data request failed with ${status}${detail}`);
    this.name = "MarketDataHttpError";
  }
}

function isTauriRuntime() {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

function isLocalDevBrowser() {
  if (typeof window === "undefined") return false;
  return ["127.0.0.1", "localhost"].includes(window.location.hostname);
}

function devProxyUrl(url: string) {
  if (!isLocalDevBrowser()) return url;

  const parsed = new URL(url);
  const route = DEV_PROXY_ROUTES[parsed.origin];
  if (!route) return url;
  return `${route}${parsed.pathname}${parsed.search}`;
}

async function fetchJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 180)}` : "";
    throw new MarketDataHttpError(response.status, detail);
  }
  return (await response.json()) as T;
}

export async function marketDataFetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  if (isTauriRuntime()) {
    try {
      return await publicMarketGet<T>(url);
    } catch (err) {
      console.warn("Tauri market data bridge failed; falling back to browser fetch", err);
    }
  }

  const proxiedUrl = devProxyUrl(url);
  try {
    return await fetchJson<T>(proxiedUrl, init);
  } catch (err) {
    if (proxiedUrl === url) throw err;
    if (err instanceof MarketDataHttpError) throw err;
    console.warn("Dev market data proxy failed; falling back to direct fetch", err);
    return fetchJson<T>(url, init);
  }
}
