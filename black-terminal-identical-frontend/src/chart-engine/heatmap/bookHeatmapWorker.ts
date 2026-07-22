/// <reference lib="webworker" />
import { compactBookSnapshot } from "./bookHeatmapProcessor.ts";
import type { OrderBookSnapshot } from "../../market-data/types";

type Request = { id: number; snapshot: OrderBookSnapshot; receivedAt: number };

self.onmessage = (event: MessageEvent<Request>) => {
  const result = compactBookSnapshot(event.data.snapshot, event.data.receivedAt);
  if (result.accepted) {
    self.postMessage({ id: event.data.id, result }, [result.buckets.buffer]);
  } else {
    self.postMessage({ id: event.data.id, result });
  }
};

export {};
