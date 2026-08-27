import type { Candle } from "../../../chart-engine/types.ts";

export type AuctionProfileReplayWindow = {
  bars: Candle[];
  sourceEndIndex: number | null;
  cutoffEnd: number | null;
  replayBounded: boolean;
};

/**
 * Selects the only candle prefix RADAP is allowed to observe.
 *
 * In live mode (and while the user is selecting a replay start) the complete
 * retained source is available. Once Replay owns a cursor, the returned
 * window ends at that cursor and then applies the configured lookback. Future
 * candles can therefore remain cached by the chart without leaking into the
 * profile calculation.
 */
export function resolveAuctionProfileReplayWindow(
  source: readonly Candle[],
  lookbackBars: number,
  replay: { enabled: boolean; selecting: boolean; cursor: number | null },
  fallbackIntervalSeconds = 1
): AuctionProfileReplayWindow {
  if (source.length === 0) {
    return { bars: [], sourceEndIndex: null, cutoffEnd: null, replayBounded: false };
  }

  const replayBounded = replay.enabled && !replay.selecting;
  const sourceEndIndex = replayBounded
    ? Math.max(0, Math.min(source.length - 1, Math.trunc(replay.cursor ?? 0)))
    : source.length - 1;
  const endExclusive = sourceEndIndex + 1;
  const boundedLookback = Math.max(1, Math.trunc(lookbackBars));
  const bars = source.slice(Math.max(0, endExclusive - boundedLookback), endExclusive);
  const last = bars.at(-1);
  const previous = bars.at(-2);
  const interval = last && previous
    ? Math.max(1, last.time - previous.time)
    : Math.max(1, Math.trunc(fallbackIntervalSeconds));

  return {
    bars,
    sourceEndIndex,
    cutoffEnd: replayBounded && last ? last.time + interval - 1 : null,
    replayBounded
  };
}
