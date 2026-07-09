import { useEffect, useMemo, useState } from "react";
import type { MarketSymbol } from "../../market-data/types";
import { blackCoreDomFeedStore, type DomFeedSnapshot } from "./domFeedStore";

export function useDomFeed(marketSymbol: MarketSymbol): DomFeedSnapshot {
  const key = useMemo(() => [marketSymbol.exchange, marketSymbol.marketKind, marketSymbol.rawSymbol].join(":"), [
    marketSymbol.exchange,
    marketSymbol.marketKind,
    marketSymbol.rawSymbol
  ]);
  const [snapshot, setSnapshot] = useState(() => blackCoreDomFeedStore.getSnapshot(marketSymbol));

  useEffect(() => {
    setSnapshot(blackCoreDomFeedStore.getSnapshot(marketSymbol));
    return blackCoreDomFeedStore.subscribe(marketSymbol, setSnapshot);
  }, [key]);

  return snapshot;
}
