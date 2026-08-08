import type { BclifCanonicalEvent, PersistentLiquidationEvent } from "../contracts.ts";
import { canonicalDecimal, canonicalEvent, finitePositive, normalizeSymbol, sha256Hex, timestampMs } from "./canonicalEnvelope.ts";

export function parseBybitLiquidations(payload: unknown, receivedTimestamp: number, sourceVersion: string) {
  const message = payload as { topic?: unknown; ts?: unknown; data?: unknown };
  if (!String(message.topic || "").startsWith("allLiquidation.")) return [];
  const rows = Array.isArray(message.data) ? message.data : message.data ? [message.data] : [];
  const events: BclifCanonicalEvent<PersistentLiquidationEvent>[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const symbol = normalizeSymbol(row.s);
    const exchangeTimestamp = timestampMs(row.T, timestampMs(message.ts, receivedTimestamp));
    const bankruptcyPrice = finitePositive(row.p, "liquidation bankruptcy price");
    const quantity = finitePositive(row.v, "liquidation quantity");
    if (row.S !== "Buy" && row.S !== "Sell") throw new Error("Bybit liquidation side is invalid");
    const liquidatedSide = row.S === "Buy" ? "LONG" as const : "SHORT" as const;
    // allLiquidation does not expose a venue event ID. Identity therefore uses
    // only immutable exchange facts so reconnect replay and websocket batch
    // reframing cannot create a second canonical event.
    const content = ["BYBIT", symbol, exchangeTimestamp, liquidatedSide, canonicalDecimal(bankruptcyPrice), canonicalDecimal(quantity)].join("|");
    const id = `BYBIT:${symbol}:LIQ:${sha256Hex(content)}`;
    const event: PersistentLiquidationEvent = {
      id,
      venue: "BYBIT",
      symbol,
      exchangeTimestamp,
      receivedTimestamp,
      liquidatedSide,
      bankruptcyPrice,
      quantity,
      estimatedNotional: bankruptcyPrice * quantity,
      certainty: "OBSERVED",
      sourceVersion
    };
    events.push(canonicalEvent({
      eventId: id,
      kind: "LIQUIDATION",
      symbol,
      exchangeTimestamp,
      receivedTimestamp,
      sourceVersion,
      payload: event
    }));
  }
  return events.sort((a, b) => a.exchangeTimestamp - b.exchangeTimestamp || a.eventId.localeCompare(b.eventId));
}
