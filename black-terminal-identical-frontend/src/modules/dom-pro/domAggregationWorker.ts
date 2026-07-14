import { DomAggregationEngine, type DomAggregationInput } from "./domAggregationEngine";

type CompactBook = { exchange: DomAggregationInput["marketSymbol"]["exchange"]; symbol: string; time: number; bids: Float64Array; asks: Float64Array };
type Request = { id: string; version: number; key: string; input: DomAggregationInput; compactBook?: CompactBook | null };

const engines = new Map<string, DomAggregationEngine>();

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, version, key, compactBook } = event.data;
  const input = compactBook ? { ...event.data.input, book: unpackOrderBook(compactBook) } : event.data.input;
  const startedAt = performance.now();
  try {
    let engine = engines.get(key);
    if (!engine) {
      engine = new DomAggregationEngine();
      engines.set(key, engine);
      while (engines.size > 8) {
        const oldest = engines.keys().next().value as string | undefined;
        if (!oldest) break;
        engines.delete(oldest);
      }
    }
    const fullSnapshot = engine.aggregate(input);
    const latestHeatmapFrame = fullSnapshot.heatmap.at(-1);
    const snapshot = {
      ...fullSnapshot,
      sourceBook: null,
      ticker: null,
      trades: [],
      heatmap: latestHeatmapFrame ? [latestHeatmapFrame] : [],
      transport: {
        heatmapMode: "delta" as const,
        heatmapRevision: latestHeatmapFrame?.time ?? 0,
        heatmapMaxFrames: Math.min(180, input.settings.maxHeatmapHistory)
      }
    };
    const inputUnits = (input.book?.bids.length ?? 0) + (input.book?.asks.length ?? 0) + input.trades.length;
    const outputUnits = snapshot.buckets.length + snapshot.walls.length + (latestHeatmapFrame?.cells.length ?? 0) + snapshot.cvdSeries.length;
    self.postMessage({ id, version, type: "done", snapshot, metrics: { processingMs: performance.now() - startedAt, inputUnits, outputUnits } });
  } catch (error) {
    self.postMessage({ id, version, type: "error", error: error instanceof Error ? error.message : String(error) });
  }
};

function unpackOrderBook(book: CompactBook) {
  return {
    exchange: book.exchange,
    symbol: book.symbol,
    time: book.time,
    bids: unpackLevels(book.bids),
    asks: unpackLevels(book.asks)
  };
}

function unpackLevels(values: Float64Array) {
  const levels = new Array<{ price: number; quantity: number }>(Math.floor(values.length / 2));
  for (let index = 0; index < levels.length; index += 1) levels[index] = { price: values[index * 2], quantity: values[index * 2 + 1] };
  return levels;
}

export {};
