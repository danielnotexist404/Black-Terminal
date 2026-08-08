import type { BclifBookFrame, BclifCanonicalEvent } from "../contracts.ts";
import { canonicalEvent } from "./canonicalEnvelope.ts";

export function canonicalBookFrameEvent(frame: BclifBookFrame): BclifCanonicalEvent<BclifBookFrame> {
  return canonicalEvent({
    eventId: `BYBIT:${frame.symbol}:BOOK:${frame.exchangeTimestamp}:${frame.updateId}:${frame.crossSequence ?? "none"}`,
    kind: "BOOK_FRAME",
    symbol: frame.symbol,
    exchangeTimestamp: frame.exchangeTimestamp,
    receivedTimestamp: frame.receivedTimestamp,
    sourceSequence: frame.crossSequence ?? frame.updateId,
    sourceVersion: frame.sourceVersion,
    payload: frame
  });
}
