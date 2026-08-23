import { useEffect, useMemo, useState } from "react";
import type { MarketSymbol, OrderBookSubscriptionOptions } from "../../market-data/types";
import { blackCoreDomFeedStore, type DomFeedSnapshot } from "./domFeedStore";

export function useDomFeed(marketSymbol: MarketSymbol, options?: OrderBookSubscriptionOptions): DomFeedSnapshot {
  const requestedDepth = Number.isFinite(options?.depth) && Number(options?.depth) > 0
    ? Math.max(1, Math.floor(Number(options?.depth)))
    : undefined;
  const key = useMemo(() => [marketSymbol.exchange, marketSymbol.marketKind, marketSymbol.rawSymbol, requestedDepth ?? "default"].join(":"), [
    marketSymbol.exchange,
    marketSymbol.marketKind,
    marketSymbol.rawSymbol,
    requestedDepth
  ]);
  const [snapshot, setSnapshot] = useState(() => blackCoreDomFeedStore.getSnapshot(marketSymbol, requestedDepth ? { depth: requestedDepth } : undefined));

  useEffect(() => {
    const depthOptions = requestedDepth ? { depth: requestedDepth } : undefined;
    setSnapshot(blackCoreDomFeedStore.getSnapshot(marketSymbol, depthOptions));
    return blackCoreDomFeedStore.subscribe(marketSymbol, setSnapshot, depthOptions);
  }, [key]);

  return snapshot;
}
