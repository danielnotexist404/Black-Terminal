import { normalizeSymbol } from "../normalization/canonicalEnvelope.ts";
import { bybitPublicGet } from "./bybitTransport.ts";

interface InstrumentResult {
  list: Array<{
    symbol: string;
    contractType: string;
    status: string;
    launchTime: string;
    deliveryTime: string;
    leverageFilter: { minLeverage: string; maxLeverage: string; leverageStep: string };
    priceFilter: { tickSize: string };
    lotSizeFilter: { qtyStep: string; minNotionalValue?: string };
    fundingInterval: number;
  }>;
}

export async function fetchBybitInstrumentInfo(symbolValue: string, signal?: AbortSignal) {
  const symbol = normalizeSymbol(symbolValue);
  const result = await bybitPublicGet<InstrumentResult>("/v5/market/instruments-info", new URLSearchParams({ category: "linear", symbol, limit: "1000" }), { signal });
  const row = result.list?.find((item) => item.symbol === symbol);
  if (!row) throw new Error(`Bybit instrument metadata unavailable for ${symbol}`);
  return {
    venue: "BYBIT" as const,
    symbol,
    contractType: row.contractType,
    status: row.status,
    launchTime: Number(row.launchTime),
    deliveryTime: Number(row.deliveryTime),
    minLeverage: Number(row.leverageFilter.minLeverage),
    maxLeverage: Number(row.leverageFilter.maxLeverage),
    leverageStep: Number(row.leverageFilter.leverageStep),
    tickSize: Number(row.priceFilter.tickSize),
    quantityStep: Number(row.lotSizeFilter.qtyStep),
    minimumNotional: Number(row.lotSizeFilter.minNotionalValue || 0),
    fundingIntervalMinutes: Number(row.fundingInterval),
    observedAt: Date.now()
  };
}
