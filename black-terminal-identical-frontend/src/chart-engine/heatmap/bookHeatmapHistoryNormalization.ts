import type { HistoricalBookHeatmapCell } from "./OrderBookHeatmapModel.ts";

export type RawBookHeatmapHistoryCell = HistoricalBookHeatmapCell & {
  time: string;
  bucketEnd?: string;
};

export function normalizeBookHeatmapHistoryCells(cells: RawBookHeatmapHistoryCell[]): HistoricalBookHeatmapCell[] {
  return (cells ?? []).map((cell) => {
    const price = Number(cell.price);
    const convert = (value: unknown) => Math.max(0, Number(value) || 0) * price;
    return {
      ...cell,
      price,
      bidSize: convert(cell.bidSize),
      askSize: convert(cell.askSize),
      bidPeakSize: convert(cell.bidPeakSize),
      askPeakSize: convert(cell.askPeakSize),
      venues: Object.fromEntries(Object.entries(cell.venues ?? {}).map(([venue, contribution]) => [venue, {
        ...contribution,
        bidSize: convert(contribution.bidSize),
        askSize: convert(contribution.askSize),
        bidPeakSize: convert(contribution.bidPeakSize),
        askPeakSize: convert(contribution.askPeakSize)
      }]))
    };
  });
}
