import type { MarketSentimentSettings } from "./types.ts";

export const DEFAULT_MARKET_SENTIMENT_SETTINGS: MarketSentimentSettings = {
  schemaVersion: 1,
  modelVersion: "BC-MSO-PYTHON-V1",
  lookback: 5000,
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
  bandFillIntensity: 7
};

const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

export function migrateMarketSentimentSettings(value?: Partial<MarketSentimentSettings> | null): MarketSentimentSettings {
  const source = value ?? {};
  const oversold = clamp(finite(source.oversold, DEFAULT_MARKET_SENTIMENT_SETTINGS.oversold), 0, 9.5);
  const overbought = clamp(finite(source.overbought, DEFAULT_MARKET_SENTIMENT_SETTINGS.overbought), oversold + 0.25, 10);
  return {
    ...DEFAULT_MARKET_SENTIMENT_SETTINGS,
    ...source,
    schemaVersion: 1,
    modelVersion: "BC-MSO-PYTHON-V1",
    lookback: Math.round(clamp(finite(source.lookback, DEFAULT_MARKET_SENTIMENT_SETTINGS.lookback), 250, 20_000)),
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
    bandFillIntensity: clamp(finite(source.bandFillIntensity, DEFAULT_MARKET_SENTIMENT_SETTINGS.bandFillIntensity), 0, 40)
  };
}
