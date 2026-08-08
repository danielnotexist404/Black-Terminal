import type { LiquidationConfidenceBreakdown, LiquidationDataCertainty, LiquidationMarketFrame } from "./types.ts";

const certaintyScore: Record<LiquidationDataCertainty, number> = {
  OBSERVED: 1,
  DERIVED: 0.86,
  ESTIMATED_HIGH: 0.78,
  ESTIMATED_MEDIUM: 0.62,
  ESTIMATED_LOW: 0.38,
  MISSING: 0,
  SYNTHETIC_TEST: 0,
  UNAVAILABLE: 0
};

export function scoreCertainty(certainty: LiquidationDataCertainty | undefined) {
  return certaintyScore[certainty ?? "UNAVAILABLE"];
}

export function confidenceForFrame(frame: LiquidationMarketFrame): LiquidationConfidenceBreakdown {
  const tradeCoverage = scoreCertainty(frame.certainty.trades);
  const openInterest = scoreCertainty(frame.certainty.openInterest);
  const entryPrice = scoreCertainty(frame.certainty.entryPrice);
  const leverage = scoreCertainty(frame.certainty.leveragePrior);
  const marginModel = scoreCertainty(frame.certainty.marginModel);
  const eventCalibration = scoreCertainty(frame.certainty.confirmedLiquidations);
  const continuity = scoreCertainty(frame.certainty.continuity);
  const penalties: string[] = [];
  if (tradeCoverage < 0.6) penalties.push("Exact historical trade-at-price coverage unavailable");
  if (eventCalibration === 0) penalties.push("Confirmed-liquidation history unavailable");
  if (scoreCertainty(frame.certainty.orderbook) === 0) penalties.push("Historical book absorption unavailable");
  if (marginModel < 0.7) penalties.push("Cross-margin collateral is not publicly observable");
  const total = Math.round(100 * (
    tradeCoverage * 0.18 +
    openInterest * 0.24 +
    entryPrice * 0.15 +
    leverage * 0.12 +
    marginModel * 0.12 +
    eventCalibration * 0.09 +
    continuity * 0.10
  ));
  return {
    total,
    tradeCoverage: Math.round(tradeCoverage * 100),
    openInterest: Math.round(openInterest * 100),
    entryPrice: Math.round(entryPrice * 100),
    leverage: Math.round(leverage * 100),
    marginModel: Math.round(marginModel * 100),
    eventCalibration: Math.round(eventCalibration * 100),
    continuity: Math.round(continuity * 100),
    penalties
  };
}
