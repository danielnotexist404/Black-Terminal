import type {
  ConfirmedLiquidationEvent,
  LiquidationCoverage,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "../core/types.ts";

export function createLiquidationFieldFixture(now = 1_900_000_000_000) {
  const start = now - 21 * 24 * 60 * 60 * 1_000;
  const frames: LiquidationMarketFrame[] = [];
  let price = 64_000;
  let openInterest = 84_000;
  let cvd = 0;
  for (let index = 0; index < 252; index++) {
    const timestamp = start + index * 2 * 60 * 60 * 1_000;
    const wave = Math.sin(index / 15) * 180 + Math.sin(index / 4.7) * 55;
    const regime = index < 72 ? -index * 3.2 : index < 150 ? (index - 72) * 4.4 : -(index - 150) * 2.1;
    price = 64_000 + wave + regime;
    const oiDelta = index % 17 < 10 ? 115 + (index % 5) * 18 : -72 - (index % 3) * 19;
    openInterest = Math.max(40_000, openInterest + oiDelta);
    const buy = 5_000_000 + (Math.sin(index / 9) + 1) * 1_200_000;
    const sell = 5_000_000 + (Math.cos(index / 11) + 1) * 1_100_000;
    cvd += buy - sell;
    frames.push({
      venue: "BYBIT",
      symbol: "BTCUSDT",
      timestamp,
      lastPrice: price,
      markPrice: price * (1 + Math.sin(index / 21) * 0.00008),
      indexPrice: price,
      basisBps: Math.sin(index / 21) * 0.8,
      openInterest,
      openInterestDelta: oiDelta,
      fundingRate: 0.0001 * Math.sin(index / 29),
      longAccountRatio: 0.49 + Math.sin(index / 18) * 0.05,
      shortAccountRatio: 0.51 - Math.sin(index / 18) * 0.05,
      aggressiveBuyNotional: buy,
      aggressiveSellNotional: sell,
      cvd,
      cvdEfficiency: Math.min(1, Math.abs(buy - sell) / (buy + sell)),
      realizedVolatility: 0.005 + Math.abs(Math.sin(index / 13)) * 0.006,
      parkinsonVolatility: 0.006 + Math.abs(Math.cos(index / 17)) * 0.005,
      bestBid: price - 0.5,
      bestAsk: price + 0.5,
      spreadBps: 0.16,
      bidDepthCurve: { points: [{ distanceBps: 1, notional: 7_000_000 }, { distanceBps: 5, notional: 24_000_000 }], certainty: "SYNTHETIC_TEST" },
      askDepthCurve: { points: [{ distanceBps: 1, notional: 6_500_000 }, { distanceBps: 5, notional: 22_000_000 }], certainty: "SYNTHETIC_TEST" },
      confirmedLongLiquidations: 0,
      confirmedShortLiquidations: 0,
      certainty: {
        trades: "SYNTHETIC_TEST", openInterest: "SYNTHETIC_TEST", entryPrice: "SYNTHETIC_TEST",
        leveragePrior: "SYNTHETIC_TEST", marginModel: "SYNTHETIC_TEST", confirmedLiquidations: "SYNTHETIC_TEST",
        continuity: "SYNTHETIC_TEST", orderbook: "SYNTHETIC_TEST"
      },
      sourceVersion: "BCLIF_DETERMINISTIC_VISUAL_FIXTURE_V1"
    });
  }
  const rules: LiquidationInstrumentRules = {
    venue: "BYBIT", symbol: "BTCUSDT", contractType: "USDT_LINEAR_PERPETUAL", contractMultiplier: 1,
    maxLeverage: 100, leverageStep: 0.01, fundingIntervalMinutes: 480, fetchedAt: now,
    sourceVersion: "BCLIF_DETERMINISTIC_VISUAL_FIXTURE_V1", certainty: "SYNTHETIC_TEST",
    riskTiers: [
      { tierId: "1", riskLimitValue: 2_000_000, maintenanceMarginRate: 0.005, initialMarginRate: 0.01, maintenanceMarginDeduction: 0, maxLeverage: 100, certainty: "SYNTHETIC_TEST" },
      { tierId: "2", riskLimitValue: 10_000_000, maintenanceMarginRate: 0.01, initialMarginRate: 0.02, maintenanceMarginDeduction: 10_000, maxLeverage: 50, certainty: "SYNTHETIC_TEST" }
    ]
  };
  const events: ConfirmedLiquidationEvent[] = [
    { id: "fixture-long", venue: "BYBIT", symbol: "BTCUSDT", timestamp: start + 190 * 2 * 60 * 60 * 1_000, receivedAt: now, liquidatedPositionSide: "LONG", quantity: 14, bankruptcyPrice: 61_850, notional: 865_900, certainty: "OBSERVED", sourceVersion: rules.sourceVersion },
    { id: "fixture-short", venue: "BYBIT", symbol: "BTCUSDT", timestamp: start + 216 * 2 * 60 * 60 * 1_000, receivedAt: now, liquidatedPositionSide: "SHORT", quantity: 9, bankruptcyPrice: 66_400, notional: 597_600, certainty: "OBSERVED", sourceVersion: rules.sourceVersion }
  ];
  const coverage: LiquidationCoverage = {
    venue: "BYBIT", symbol: "BTCUSDT", horizon: "3W", requestedStart: start, requestedEnd: now,
    availableStart: start, availableEnd: now, observedTradeCoveragePercent: 100, openInterestCoveragePercent: 100,
    liquidationEventCoveragePercent: 100, orderbookCoveragePercent: 100, modelContinuityPercent: 100,
    missingIntervals: [], quality: "EXCELLENT", state: "SYNTHETIC_TEST"
  };
  return { frames, events, rules, coverage };
}
