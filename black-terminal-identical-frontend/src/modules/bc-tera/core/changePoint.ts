import type { BCTERAChangeDirection } from "./types.ts";
import { clamp01 } from "./statistics.ts";

export type DirectionalCUSUMState = {
  positive: number;
  negative: number;
  runLength: number;
  direction: BCTERAChangeDirection;
  probability: number;
};

export type DirectionalCUSUMResult = DirectionalCUSUMState;

export const INITIAL_CUSUM_STATE: DirectionalCUSUMState = {
  positive: 0,
  negative: 0,
  runLength: 0,
  direction: "NEUTRAL",
  probability: 0
};

export function updateDirectionalCUSUM(
  previous: DirectionalCUSUMState,
  standardizedImpulse: number,
  sensitivity: number,
  minimumRunLength: number
): DirectionalCUSUMResult {
  const drift = Math.max(0.05, sensitivity * 0.08);
  const positive = Math.max(0, previous.positive + standardizedImpulse - drift);
  const negative = Math.max(0, previous.negative - standardizedImpulse - drift);
  const rawDirection: BCTERAChangeDirection = positive > negative
    ? "BULLISH"
    : negative > positive
      ? "BEARISH"
      : "NEUTRAL";
  const runLength = rawDirection === "NEUTRAL"
    ? 0
    : rawDirection === previous.direction
      ? previous.runLength + 1
      : 1;
  const evidence = Math.max(positive, negative);
  const runGate = Math.min(1, runLength / Math.max(1, minimumRunLength));
  const probability = clamp01((1 - Math.exp(-evidence / Math.max(0.25, sensitivity))) * runGate);
  return { positive, negative, runLength, direction: rawDirection, probability };
}
