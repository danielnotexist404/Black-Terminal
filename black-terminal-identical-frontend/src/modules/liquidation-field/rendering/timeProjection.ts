/**
 * BCLIF snapshots use Unix milliseconds while BlackChartEngine candles use
 * Unix seconds. Keep the conversion at the renderer/chart boundary so the
 * model and its event timestamps retain their canonical precision.
 */
export function bclifTimestampMsToChartSeconds(timestampMs: number) {
  return timestampMs / 1_000;
}
