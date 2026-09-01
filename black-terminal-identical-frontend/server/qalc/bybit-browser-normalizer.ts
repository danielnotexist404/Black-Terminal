import type { QalcMarketEvent, QalcSymbol, QalcTradePayload } from "./contracts.ts";

/** Browser-safe Bybit public-stream normalizer used by the local desktop host. */
export function normalizeLocalBybitMessage(payload: Record<string, unknown>, symbol: QalcSymbol, receiveTimestamp: number): QalcMarketEvent[] {
  const topic = String(payload.topic || "");
  const processTimestamp = Date.now();
  if (topic === `orderbook.200.${symbol}`) {
    const data = object(payload.data);
    const updateId = String(data.u ?? "");
    if (!/^\d+$/.test(updateId)) return [];
    const eventType = payload.type === "snapshot" ? "BOOK_SNAPSHOT" as const : "BOOK_DELTA" as const;
    const exchangeTimestamp = finite(payload.ts, receiveTimestamp);
    const matchingTimestamp = data.cts === undefined ? undefined : finite(data.cts, exchangeTimestamp);
    return [{
      id: `bybit:${symbol}:book:${eventType}:${updateId}:${String(data.seq ?? "na")}`,
      venue: "BYBIT",
      category: "linear",
      symbol,
      eventType,
      exchangeTimestamp,
      matchingTimestamp,
      receiveTimestamp,
      processTimestamp,
      sequence: data.seq === undefined ? undefined : String(data.seq),
      updateId,
      payloadVersion: 1,
      payload: { bids: levels(data.b), asks: levels(data.a), updateId, crossSequence: data.seq === undefined ? undefined : String(data.seq), systemTimestamp: exchangeTimestamp, matchingTimestamp, depth: 200 },
    }];
  }
  if (topic === `publicTrade.${symbol}` && Array.isArray(payload.data)) {
    return payload.data.flatMap((input, index) => {
      const row = object(input);
      const tradeId = String(row.i || "");
      const price = finite(row.p);
      const quantity = finite(row.v);
      if (!tradeId || price <= 0 || quantity <= 0 || !["Buy", "Sell"].includes(String(row.S))) return [];
      const trade: QalcTradePayload = { tradeId, side: row.S === "Buy" ? "BUY" : "SELL", price, quantity, notional: price * quantity, crossSequence: row.seq === undefined && payload.seq === undefined ? undefined : String(row.seq ?? payload.seq), blockTrade: Boolean(row.BT), rpiTrade: Boolean(row.RPI) };
      return [{
        id: `bybit:${symbol}:trade:${tradeId}:${index}`,
        venue: "BYBIT" as const,
        category: "linear" as const,
        symbol,
        eventType: "TRADE" as const,
        exchangeTimestamp: finite(row.T, finite(payload.ts, receiveTimestamp)),
        receiveTimestamp,
        processTimestamp,
        sequence: trade.crossSequence,
        payloadVersion: 1 as const,
        payload: trade,
      }];
    });
  }
  return [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function levels(value: unknown): Array<readonly [number, number]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => Array.isArray(row) && finite(row[0]) > 0 && finite(row[1]) >= 0 ? [[finite(row[0]), finite(row[1])] as const] : []);
}
