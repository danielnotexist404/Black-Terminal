import { confidenceForFrame } from "../../../src/modules/liquidation-field/core/certainty.ts";
import type { LiquidationMarketFrame } from "../../../src/modules/liquidation-field/core/types.ts";

export function collectorFrameConfidence(frame: LiquidationMarketFrame) {
  const breakdown = confidenceForFrame(frame);
  return {
    ...breakdown,
    encoded: Math.max(0, Math.min(255, Math.round(breakdown.total * 2.55)))
  };
}
