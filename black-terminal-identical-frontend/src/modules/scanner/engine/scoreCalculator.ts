import type { Candle } from "../../../chart-engine/types";
import type { ScannerScoringConfig } from "../types/scanner.types";
import { atr, ema, roc, rsi, sma } from "./indicatorAdapter";

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

export function calculateScannerScore(candles: Candle[], scoring: ScannerScoringConfig) {
  if (!scoring.enabled || candles.length < 20) return 0;
  const last = candles[candles.length - 1];
  if (!last) return 0;

  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const index = candles.length - 1;
  const weights = {
    trend: scoring.weights?.trend ?? 25,
    volume: scoring.weights?.volume ?? 20,
    momentum: scoring.weights?.momentum ?? 20,
    volatility: scoring.weights?.volatility ?? 15,
    relativeStrength: scoring.weights?.relativeStrength ?? 20
  };
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const volSma20 = sma(volumes, 20);
  const roc20 = roc(closes, 20);
  const range = last.high - last.low;
  const relVolume = last.volume / Math.max(1, volSma20[index] ?? last.volume);

  const trendScore = (
    (last.close > (ema50[index] ?? last.close) ? 0.34 : 0) +
    (last.close > (ema200[index] ?? last.close) ? 0.34 : 0) +
    ((ema50[index] ?? 0) > (ema200[index] ?? 0) ? 0.32 : 0)
  ) * weights.trend;
  const volumeScore = clamp((relVolume - 0.7) / 1.3, 0, 1) * weights.volume;
  const momentumCenter = Math.abs((rsi14[index] ?? 50) - 50) / 50;
  const momentumScore = clamp(momentumCenter * 0.55 + Math.max(0, roc20[index] ?? 0) / 12 * 0.45, 0, 1) * weights.momentum;
  const volatilityScore = clamp(range / Math.max(1e-8, atr14[index] ?? range) / 1.8, 0, 1) * weights.volatility;
  const relativeStrengthScore = clamp(Math.max(0, roc20[index] ?? 0) / 10, 0, 1) * weights.relativeStrength;

  return clamp(trendScore + volumeScore + momentumScore + volatilityScore + relativeStrengthScore);
}

export function relativeVolume(candles: Candle[], period = 20) {
  const last = candles[candles.length - 1];
  if (!last) return null;
  const average = sma(candles.map((candle) => candle.volume), period).at(-1);
  return average ? last.volume / average : null;
}
