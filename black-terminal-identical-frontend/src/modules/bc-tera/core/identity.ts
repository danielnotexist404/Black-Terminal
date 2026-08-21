import type { BCTERAEvent, BCTERAEventType, BCTERAPoint, BCTERAFeatureBar } from "./types.ts";
import { BC_TERA_MODEL_VERSION } from "./types.ts";

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createTerminalEpisodeId(bar: BCTERAFeatureBar, side: "TOP" | "BOTTOM" | "DATA") {
  return `${side.toLowerCase()}-${stableHash([
    BC_TERA_MODEL_VERSION,
    bar.profile,
    bar.exchangeScope,
    bar.symbol,
    bar.timeframe,
    bar.time
  ].join("|"))}`;
}

export function createBCTERAEvent(
  bar: BCTERAFeatureBar,
  point: BCTERAPoint,
  eventType: BCTERAEventType,
  terminalEpisodeId: string
): BCTERAEvent {
  const canonical = [
    BC_TERA_MODEL_VERSION,
    bar.profile,
    bar.exchangeScope,
    bar.symbol,
    bar.timeframe,
    eventType,
    bar.time,
    terminalEpisodeId
  ].join("|");
  return {
    id: `bc-tera-${stableHash(canonical)}`,
    modelVersion: BC_TERA_MODEL_VERSION,
    datasetProfile: bar.profile,
    exchangeScope: bar.exchangeScope,
    symbol: bar.symbol,
    timeframe: bar.timeframe,
    eventType,
    confirmedCandleTimestamp: bar.time,
    terminalEpisodeId,
    state: point.state,
    topHazard: point.topHazard,
    bottomHazard: point.bottomHazard,
    dataConfidence: point.dataConfidence,
    evidence: point.evidence,
    unavailable: [...point.unavailable]
  };
}
