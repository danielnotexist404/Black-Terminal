import type { BclifCanonicalEvent, PersistentPublicTrade } from "../contracts.ts";
import { canonicalDecimal, canonicalEvent, finitePositive, normalizeSymbol, timestampMs } from "./canonicalEnvelope.ts";

export function parseBybitPublicTrades(payload: unknown, receivedTimestamp: number, sourceVersion: string) {
  const message = payload as { topic?: unknown; data?: unknown };
  if (!String(message.topic || "").startsWith("publicTrade.") || !Array.isArray(message.data)) return [];
  const trades: BclifCanonicalEvent<PersistentPublicTrade>[] = [];
  for (const row of message.data as Array<Record<string, unknown>>) {
    const symbol = normalizeSymbol(row.s);
    const tradeId = String(row.i || "").trim();
    if (!tradeId) throw new Error("Bybit public trade omitted trade ID");
    const exchangeTimestamp = timestampMs(row.T);
    const price = finitePositive(row.p, "trade price");
    const quantity = finitePositive(row.v, "trade quantity");
    const aggressorSide = row.S === "Buy" ? "BUY" as const : row.S === "Sell" ? "SELL" as const : "UNKNOWN" as const;
    const trade: PersistentPublicTrade = {
      venue: "BYBIT",
      symbol,
      tradeId,
      exchangeTimestamp,
      receivedTimestamp,
      sequence: row.seq == null ? null : String(row.seq),
      price,
      quantity,
      notional: price * quantity,
      aggressorSide,
      certainty: "OBSERVED",
      sourceVersion
    };
    trades.push(canonicalEvent({
      eventId: `BYBIT:${symbol}:TRADE:${tradeId}`,
      kind: "TRADE",
      symbol,
      exchangeTimestamp,
      receivedTimestamp,
      sourceSequence: row.seq as string | number | null,
      sourceVersion,
      payload: trade
    }));
  }
  return trades.sort((a, b) =>
    a.exchangeTimestamp - b.exchangeTimestamp
    || compareSequence(a.sourceSequence, b.sourceSequence)
    || a.eventId.localeCompare(b.eventId)
  );
}

function compareSequence(a: string | null, b: string | null) {
  if (a === b) return 0;
  try {
    const left = BigInt(a || "0");
    const right = BigInt(b || "0");
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return String(a).localeCompare(String(b));
  }
}

export function tradeDedupKey(trade: PersistentPublicTrade) {
  return [trade.venue, trade.symbol, trade.tradeId, canonicalDecimal(trade.price), canonicalDecimal(trade.quantity)].join(":");
}
