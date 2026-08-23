import type { QalcIndicatorSettings } from "../../chart-engine/types";
import type { QalcDraftSeed } from "../strategy-lab/qalc/qalcApi";

export const QALC_HANDOFF_STORAGE_KEY = "bt_qalc_strategy_handoff_v1";

export type QalcStrategyHandoff = {
  schemaVersion: 1;
  engineId: "black-core-qalc";
  symbol: "BTCUSDT" | "ETHUSDT";
  exchange: "BYBIT";
  capturedAt: number;
  openRequested?: boolean;
  configurationHash: string;
  settings: QalcIndicatorSettings;
};

export function stableQalcConfigurationHash(settings: QalcIndicatorSettings) {
  const text = JSON.stringify(sortValue(settings));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function saveQalcStrategyHandoff(symbol: string, settings: QalcIndicatorSettings) {
  if (typeof window === "undefined") return undefined;
  const canonicalSymbol = symbol.toUpperCase() === "ETHUSDT" ? "ETHUSDT" : "BTCUSDT";
  const handoff: QalcStrategyHandoff = {
    schemaVersion: 1,
    engineId: "black-core-qalc",
    symbol: canonicalSymbol,
    exchange: "BYBIT",
    capturedAt: Date.now(),
    openRequested: true,
    configurationHash: stableQalcConfigurationHash(settings),
    settings: structuredClone(settings),
  };
  window.localStorage.setItem(QALC_HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
  window.dispatchEvent(new CustomEvent("bt:qalc-open-strategy-lab", { detail: { configurationHash: handoff.configurationHash } }));
  return handoff;
}

export function consumeQalcStrategyHandoffIntent() {
  const handoff = loadQalcStrategyHandoff();
  if (!handoff?.openRequested || typeof window === "undefined") return false;
  window.localStorage.setItem(QALC_HANDOFF_STORAGE_KEY, JSON.stringify({ ...handoff, openRequested: false }));
  return true;
}

export function loadQalcStrategyHandoff(): QalcStrategyHandoff | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(QALC_HANDOFF_STORAGE_KEY) || "null") as QalcStrategyHandoff | null;
    if (parsed?.schemaVersion !== 1 || parsed.engineId !== "black-core-qalc" || !parsed.settings) return undefined;
    if (parsed.configurationHash !== stableQalcConfigurationHash(parsed.settings)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function qalcDraftFromHandoff(handoff?: QalcStrategyHandoff): QalcDraftSeed {
  if (!handoff) return {};
  return {
    name: `BC-QALC ${handoff.symbol} Paper Candidate`,
    symbol: handoff.symbol,
    mode: "PAPER",
    config: {
      predictionHorizonMs: handoff.settings.predictionHorizonMs,
      minimumNetEdgeMultiplier: handoff.settings.minimumNetEdgeMultiplier,
      maximumToxicity: handoff.settings.maximumToxicity,
      minimumFillProbability: handoff.settings.minimumFillProbability,
      quoteLifetimeMs: handoff.settings.quoteLifetimeMs,
      indicatorConfigHash: handoff.configurationHash,
      indicatorConfigVersion: handoff.settings.schemaVersion,
      chartDisplayMode: handoff.settings.displayMode,
      chartMarkerSize: handoff.settings.markerSize,
      chartPaneHeight: handoff.settings.paneHeight,
      sourceRunId: handoff.settings.selectedRunId,
    },
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((output, key) => {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
    return output;
  }, {});
  return value;
}
