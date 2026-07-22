export type BinanceBookContinuity = {
  snapshotReady: boolean;
  lastUpdateId: number;
  previousFinalUpdateId: number;
};

export type BinanceDepthUpdate = {
  firstUpdateId: number;
  finalUpdateId: number;
  previousFinalUpdateId?: number;
};

export function classifyBinanceDepthUpdate(
  current: BinanceBookContinuity,
  update: BinanceDepthUpdate
): "buffer" | "ignore" | "apply" | "resync" {
  if (!current.snapshotReady) return "buffer";
  if (update.finalUpdateId < current.lastUpdateId) return "ignore";
  if (
    current.previousFinalUpdateId > 0 &&
    Boolean(update.previousFinalUpdateId) &&
    update.previousFinalUpdateId !== current.previousFinalUpdateId
  ) return "resync";
  if (current.previousFinalUpdateId === 0 && update.firstUpdateId > current.lastUpdateId + 1) return "resync";
  return "apply";
}
