import type { Candle } from "../../../chart-engine/types.ts";

export type EstimatedBarDelta = {
  buyQuantity: number;
  sellQuantity: number;
  unknownQuantity: number;
  confidence: number;
};

export function estimateBarDelta(bar: Candle): EstimatedBarDelta {
  const range = Math.max(Number.EPSILON, bar.high - bar.low);
  const bodyPosition = Math.max(0, Math.min(1, (bar.close - bar.low) / range));
  const body = Math.abs(bar.close - bar.open) / range;
  const directionalWeight = Math.max(0.05, Math.min(0.95, 0.5 + (bodyPosition - 0.5) * (0.7 + 0.3 * body)));
  const buyQuantity = bar.volume * directionalWeight;
  const sellQuantity = Math.max(0, bar.volume - buyQuantity);
  return { buyQuantity, sellQuantity, unknownQuantity: 0, confidence: Math.min(0.65, 0.2 + body * 0.45) };
}
