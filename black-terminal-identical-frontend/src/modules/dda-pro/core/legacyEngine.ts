import type { Candle } from "../../../chart-engine/types.ts";
import type { DDAProEvent, DDAProSignalEvent } from "./types.ts";
import { DDA_PRO_INDICATOR_ID } from "./types.ts";

export const BC_RDA_LEGACY_ENGINE_VERSION = "BC_RDA_PRE_532_LEGACY_V1" as const;

/**
 * Exact directional mapping used immediately before commit 532af4a. This is
 * intentionally isolated from the corrected model so selecting legacy mode
 * cannot mutate V2 anchors, episodes, candidates, or alert identities.
 */
export function deriveLegacyDDAProSignals(events: readonly DDAProEvent[]): DDAProSignalEvent[] {
  const signals: DDAProSignalEvent[] = [];
  for (const event of events) {
    if (event.type === "DDA_DRAWDOWN_DEEPENED") signals.push({
      id: `bc-rda-long-${event.time || event.index}`,
      indicatorId: DDA_PRO_INDICATOR_ID,
      direction: "long",
      index: event.index,
      time: event.time,
      value: event.value,
      sourceEventType: event.type,
      markerTone: "silver-white"
    });
    if (event.type === "DDA_DRAWDOWN_RECOVERED") signals.push({
      id: `bc-rda-short-${event.time || event.index}`,
      indicatorId: DDA_PRO_INDICATOR_ID,
      direction: "short",
      index: event.index,
      time: event.time,
      value: event.value,
      sourceEventType: event.type,
      markerTone: "blood-red"
    });
  }
  return signals;
}

/** Exact prefix-stable filtered candidate stream from the pre-532 model. */
export function deriveLegacyCausalDDAProSignalCandidates(
  candles: readonly Candle[],
  depth: readonly number[],
  episodeThresholdPercent: number
): DDAProSignalEvent[] {
  const signals: DDAProSignalEvent[] = [];
  const recoveryThreshold = Math.max(1e-9, episodeThresholdPercent * 0.05);
  let active = false;
  let episodeMaximum = 0;
  for (let index = 0; index < depth.length; index++) {
    const current = Math.max(0, Number(depth[index]) || 0);
    const time = candles[index]?.time ?? 0;
    if (!active && current >= episodeThresholdPercent && current > 0) {
      active = true;
      episodeMaximum = current;
      continue;
    }
    if (!active) continue;
    if (current > episodeMaximum + 1e-12) {
      episodeMaximum = current;
      signals.push({
        id: `bc-rda-causal-long-${time || index}`,
        indicatorId: DDA_PRO_INDICATOR_ID,
        direction: "long",
        index,
        time,
        value: current,
        sourceEventType: "DDA_DRAWDOWN_DEEPENED",
        markerTone: "silver-white"
      });
    }
    if (current < recoveryThreshold) {
      signals.push({
        id: `bc-rda-causal-short-${time || index}`,
        indicatorId: DDA_PRO_INDICATOR_ID,
        direction: "short",
        index,
        time,
        value: episodeMaximum,
        sourceEventType: "DDA_DRAWDOWN_RECOVERED",
        markerTone: "blood-red"
      });
      active = false;
      episodeMaximum = 0;
    }
  }
  return signals;
}
