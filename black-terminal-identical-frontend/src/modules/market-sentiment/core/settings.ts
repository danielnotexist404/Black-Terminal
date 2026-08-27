import type { MarketSentimentSettings } from "./types.ts";

export const DEFAULT_MARKET_SENTIMENT_SETTINGS: MarketSentimentSettings = {
  schemaVersion: 2,
  modelVersion: "BC-MSO-PYTHON-V2",
  lookback: 5000,
  calculationMode: "ORIGINAL_COMPOSITE",
  candleView: true,
  candleTransform: 4,
  heikinAshi: true,
  smoothingEnabled: false,
  smoothingLength: 4,
  overbought: 8,
  oversold: 3,
  bullishColor: "#f2f2f4",
  bearishColor: "#d00024",
  neutralColor: "#777b83",
  lineColor: "#f2f2f4",
  candleIntensity: 94,
  lineIntensity: 92,
  lineWidth: 1.35,
  bandIntensity: 58,
  showBandFill: true,
  bandFillIntensity: 7,
  adaptiveWindow: 1000,
  minimumCalibrationSamples: 120,
  tailConfidence: 97.5,
  evtThresholdPercentile: 90,
  evtMinimumTailSamples: 24,
  atrLength: 21,
  regimeLength: 144,
  regimeSlopeLength: 13,
  regimeThreshold: 0.35,
  trendExpansion: 1.5,
  minimumTailDwell: 2,
  structureLength: 8,
  requireStructureConfirmation: true,
  signalCooldownBars: 24,
  showRawComposite: false,
  showDynamicBands: true
};

const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const mode = (value: unknown): MarketSentimentSettings["calculationMode"] =>
  value === "REGIME_PERCENTILE" || value === "ADAPTIVE_EVT" ? value : "ORIGINAL_COMPOSITE";

export function migrateMarketSentimentSettings(value?: Partial<MarketSentimentSettings> | null): MarketSentimentSettings {
  const source = value ?? {};
  const oversold = clamp(finite(source.oversold, DEFAULT_MARKET_SENTIMENT_SETTINGS.oversold), 0, 9.5);
  const overbought = clamp(finite(source.overbought, DEFAULT_MARKET_SENTIMENT_SETTINGS.overbought), oversold + 0.25, 10);
  const adaptiveWindow = Math.round(clamp(finite(source.adaptiveWindow, DEFAULT_MARKET_SENTIMENT_SETTINGS.adaptiveWindow), 250, 5000));
  return {
    ...DEFAULT_MARKET_SENTIMENT_SETTINGS,
    ...source,
    schemaVersion: 2,
    modelVersion: "BC-MSO-PYTHON-V2",
    lookback: Math.round(clamp(finite(source.lookback, DEFAULT_MARKET_SENTIMENT_SETTINGS.lookback), 250, 20_000)),
    calculationMode: mode(source.calculationMode),
    candleView: source.candleView !== false,
    candleTransform: Math.round(clamp(finite(source.candleTransform, DEFAULT_MARKET_SENTIMENT_SETTINGS.candleTransform), 1, 100)),
    heikinAshi: source.heikinAshi !== false,
    smoothingEnabled: source.smoothingEnabled === true,
    smoothingLength: Math.round(clamp(finite(source.smoothingLength, DEFAULT_MARKET_SENTIMENT_SETTINGS.smoothingLength), 1, 100)),
    overbought,
    oversold,
    bullishColor: color(source.bullishColor, DEFAULT_MARKET_SENTIMENT_SETTINGS.bullishColor),
    bearishColor: color(source.bearishColor, DEFAULT_MARKET_SENTIMENT_SETTINGS.bearishColor),
    neutralColor: color(source.neutralColor, DEFAULT_MARKET_SENTIMENT_SETTINGS.neutralColor),
    lineColor: color(source.lineColor, DEFAULT_MARKET_SENTIMENT_SETTINGS.lineColor),
    candleIntensity: clamp(finite(source.candleIntensity, DEFAULT_MARKET_SENTIMENT_SETTINGS.candleIntensity), 0, 100),
    lineIntensity: clamp(finite(source.lineIntensity, DEFAULT_MARKET_SENTIMENT_SETTINGS.lineIntensity), 0, 100),
    lineWidth: clamp(finite(source.lineWidth, DEFAULT_MARKET_SENTIMENT_SETTINGS.lineWidth), 0.5, 5),
    bandIntensity: clamp(finite(source.bandIntensity, DEFAULT_MARKET_SENTIMENT_SETTINGS.bandIntensity), 0, 100),
    showBandFill: source.showBandFill !== false,
    bandFillIntensity: clamp(finite(source.bandFillIntensity, DEFAULT_MARKET_SENTIMENT_SETTINGS.bandFillIntensity), 0, 40),
    adaptiveWindow,
    minimumCalibrationSamples: Math.round(clamp(finite(source.minimumCalibrationSamples, DEFAULT_MARKET_SENTIMENT_SETTINGS.minimumCalibrationSamples), 40, Math.min(1000, adaptiveWindow))),
    tailConfidence: clamp(finite(source.tailConfidence, DEFAULT_MARKET_SENTIMENT_SETTINGS.tailConfidence), 90, 99.5),
    evtThresholdPercentile: clamp(finite(source.evtThresholdPercentile, DEFAULT_MARKET_SENTIMENT_SETTINGS.evtThresholdPercentile), 80, 97.5),
    evtMinimumTailSamples: Math.round(clamp(finite(source.evtMinimumTailSamples, DEFAULT_MARKET_SENTIMENT_SETTINGS.evtMinimumTailSamples), 12, 250)),
    atrLength: Math.round(clamp(finite(source.atrLength, DEFAULT_MARKET_SENTIMENT_SETTINGS.atrLength), 5, 200)),
    regimeLength: Math.round(clamp(finite(source.regimeLength, DEFAULT_MARKET_SENTIMENT_SETTINGS.regimeLength), 20, 500)),
    regimeSlopeLength: Math.round(clamp(finite(source.regimeSlopeLength, DEFAULT_MARKET_SENTIMENT_SETTINGS.regimeSlopeLength), 2, 100)),
    regimeThreshold: clamp(finite(source.regimeThreshold, DEFAULT_MARKET_SENTIMENT_SETTINGS.regimeThreshold), 0.05, 2.5),
    trendExpansion: clamp(finite(source.trendExpansion, DEFAULT_MARKET_SENTIMENT_SETTINGS.trendExpansion), 0, 2.4),
    minimumTailDwell: Math.round(clamp(finite(source.minimumTailDwell, DEFAULT_MARKET_SENTIMENT_SETTINGS.minimumTailDwell), 1, 8)),
    structureLength: Math.round(clamp(finite(source.structureLength, DEFAULT_MARKET_SENTIMENT_SETTINGS.structureLength), 2, 50)),
    requireStructureConfirmation: source.requireStructureConfirmation !== false,
    signalCooldownBars: Math.round(clamp(finite(source.signalCooldownBars, DEFAULT_MARKET_SENTIMENT_SETTINGS.signalCooldownBars), 0, 500)),
    showRawComposite: source.showRawComposite === true,
    showDynamicBands: source.showDynamicBands !== false
  };
}
