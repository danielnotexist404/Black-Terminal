import type { QalcMarketEvent } from "./contracts.ts";

type SequencerResult = {
  accepted: boolean;
  duplicate: boolean;
  reason?: "EVENT_ID_DUPLICATE" | "TRADE_ID_DUPLICATE" | "EVENT_TIME_REGRESSION" | "RECEIVE_TIME_REGRESSION";
};

/** Bounded replay/dedupe guard. It does not invent sequence continuity rules. */
export class QalcEventSequencer {
  private readonly retentionMs: number;
  private readonly toleratedExchangeRegressionMs: number;
  private readonly seenEventIds = new Map<string, number>();
  private readonly seenTradeIds = new Map<string, number>();
  private latestExchangeTime = 0;
  private latestReceiveTime = 0;

  constructor(retentionMs = 120_000, toleratedExchangeRegressionMs = 2_000) {
    this.retentionMs = retentionMs;
    this.toleratedExchangeRegressionMs = toleratedExchangeRegressionMs;
  }

  accept(event: QalcMarketEvent): SequencerResult {
    this.prune(event.receiveTimestamp);
    if (this.seenEventIds.has(event.id)) return { accepted: false, duplicate: true, reason: "EVENT_ID_DUPLICATE" };
    if (event.eventType === "TRADE") {
      const tradeId = String((event.payload as { tradeId?: string }).tradeId || "");
      const tradeKey = `${event.symbol}:${tradeId}`;
      if (tradeId && this.seenTradeIds.has(tradeKey)) return { accepted: false, duplicate: true, reason: "TRADE_ID_DUPLICATE" };
      if (tradeId) this.seenTradeIds.set(tradeKey, event.receiveTimestamp);
    }
    if (event.exchangeTimestamp + this.toleratedExchangeRegressionMs < this.latestExchangeTime) {
      return { accepted: false, duplicate: false, reason: "EVENT_TIME_REGRESSION" };
    }
    if (event.receiveTimestamp < this.latestReceiveTime - 50) {
      return { accepted: false, duplicate: false, reason: "RECEIVE_TIME_REGRESSION" };
    }
    this.seenEventIds.set(event.id, event.receiveTimestamp);
    this.latestExchangeTime = Math.max(this.latestExchangeTime, event.exchangeTimestamp);
    this.latestReceiveTime = Math.max(this.latestReceiveTime, event.receiveTimestamp);
    return { accepted: true, duplicate: false };
  }

  reset() {
    this.seenEventIds.clear();
    this.seenTradeIds.clear();
    this.latestExchangeTime = 0;
    this.latestReceiveTime = 0;
  }

  private prune(now: number) {
    const cutoff = now - this.retentionMs;
    for (const [key, time] of this.seenEventIds) if (time < cutoff) this.seenEventIds.delete(key);
    for (const [key, time] of this.seenTradeIds) if (time < cutoff) this.seenTradeIds.delete(key);
  }
}
