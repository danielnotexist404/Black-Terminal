import type {
  ConfirmedLiquidationEvent,
  LiquidationCoverage,
  LiquidationFieldSnapshot,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "../core/types.ts";
import type { LiquidationFieldSettings } from "../core/types.ts";
import { applyBclifPresentationPreset } from "../core/settings.ts";
import type { Candle } from "../../../chart-engine/types.ts";

export const BCLIF_VISUAL_FIXTURE_END_SECONDS = 1_900_000_000;
export const BCLIF_VISUAL_FIXTURE_VERSION = "BCLIF_DETERMINISTIC_VISUAL_FIXTURE_V2_HIRES";

export const BCLIF_VISUAL_CASES = [
  "TRADE_FOCUS",
  "HIGH_CONFIDENCE",
  "LIVE_CALIBRATED",
  "FULL_SPECTRUM_RESEARCH",
  "MISSING_DATA",
  "BROWSER_FALLBACK",
  "PERSISTENT_NODE"
] as const;
export type BclifVisualCase = typeof BCLIF_VISUAL_CASES[number];

export function resolveBclifVisualCase(locationValue?: Pick<Location, "search">): BclifVisualCase {
  const resolved = locationValue ?? (typeof window === "undefined" ? { search: "" } : window.location);
  const candidate = new URLSearchParams(resolved.search).get("bclifVisualCase");
  return BCLIF_VISUAL_CASES.includes(candidate as BclifVisualCase)
    ? candidate as BclifVisualCase
    : "TRADE_FOCUS";
}

export function applyBclifVisualFixtureSettings(settings: LiquidationFieldSettings): LiquidationFieldSettings {
  const visualCase = resolveBclifVisualCase();
  if (visualCase === "HIGH_CONFIDENCE") return applyBclifPresentationPreset(settings, "HIGH_CONFIDENCE");
  if (visualCase === "LIVE_CALIBRATED") return applyBclifPresentationPreset(settings, "LIVE_CALIBRATED");
  if (visualCase === "FULL_SPECTRUM_RESEARCH") return applyBclifPresentationPreset(settings, "FULL_SPECTRUM_RESEARCH");
  return applyBclifPresentationPreset(settings, "TRADE_FOCUS");
}

export function createLiquidationFieldFixture(now = 1_900_000_000_000) {
  const frameCount = 1_008;
  const stepMs = 30 * 60 * 1_000;
  const start = now - (frameCount - 1) * stepMs;
  const frames: LiquidationMarketFrame[] = [];
  let price = 64_000;
  let openInterest = 84_000;
  let cvd = 0;
  for (let index = 0; index < frameCount; index++) {
    const timestamp = start + index * stepMs;
    const phase = index / 4;
    const phaseBucket = Math.floor(phase);
    const wave = Math.sin(phase / 15) * 180 + Math.sin(phase / 4.7) * 55;
    const regime = phase < 72 ? -phase * 3.2 : phase < 150 ? (phase - 72) * 4.4 : -(phase - 150) * 2.1;
    price = 64_000 + wave + regime;
    const oiDelta = (phaseBucket % 17 < 10 ? 115 + (phaseBucket % 5) * 18 : -72 - (phaseBucket % 3) * 19) / 4;
    openInterest = Math.max(40_000, openInterest + oiDelta);
    const buy = (5_000_000 + (Math.sin(phase / 9) + 1) * 1_200_000) / 4;
    const sell = (5_000_000 + (Math.cos(phase / 11) + 1) * 1_100_000) / 4;
    cvd += buy - sell;
    frames.push({
      venue: "BYBIT",
      symbol: "BTCUSDT",
      timestamp,
      lastPrice: price,
      markPrice: price * (1 + Math.sin(phase / 21) * 0.00008),
      indexPrice: price,
      basisBps: Math.sin(phase / 21) * 0.8,
      openInterest,
      openInterestDelta: oiDelta,
      fundingRate: 0.0001 * Math.sin(phase / 29),
      longAccountRatio: 0.49 + Math.sin(phase / 18) * 0.05,
      shortAccountRatio: 0.51 - Math.sin(phase / 18) * 0.05,
      aggressiveBuyNotional: buy,
      aggressiveSellNotional: sell,
      cvd,
      cvdEfficiency: Math.min(1, Math.abs(buy - sell) / (buy + sell)),
      realizedVolatility: 0.005 + Math.abs(Math.sin(phase / 13)) * 0.006,
      parkinsonVolatility: 0.006 + Math.abs(Math.cos(phase / 17)) * 0.005,
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
      sourceVersion: BCLIF_VISUAL_FIXTURE_VERSION
    });
  }
  const rules: LiquidationInstrumentRules = {
    venue: "BYBIT", symbol: "BTCUSDT", contractType: "USDT_LINEAR_PERPETUAL", contractMultiplier: 1,
    maxLeverage: 100, leverageStep: 0.01, fundingIntervalMinutes: 480, fetchedAt: now,
    sourceVersion: BCLIF_VISUAL_FIXTURE_VERSION, certainty: "SYNTHETIC_TEST",
    riskTiers: [
      { tierId: "1", riskLimitValue: 2_000_000, maintenanceMarginRate: 0.005, initialMarginRate: 0.01, maintenanceMarginDeduction: 0, maxLeverage: 100, certainty: "SYNTHETIC_TEST" },
      { tierId: "2", riskLimitValue: 10_000_000, maintenanceMarginRate: 0.01, initialMarginRate: 0.02, maintenanceMarginDeduction: 10_000, maxLeverage: 50, certainty: "SYNTHETIC_TEST" }
    ]
  };
  const events: ConfirmedLiquidationEvent[] = [
    { id: "fixture-long", venue: "BYBIT", symbol: "BTCUSDT", timestamp: start + 760 * stepMs, receivedAt: start + 760 * stepMs + 250, liquidatedPositionSide: "LONG", quantity: 14, bankruptcyPrice: 61_850, notional: 865_900, certainty: "OBSERVED", sourceVersion: rules.sourceVersion },
    { id: "fixture-short", venue: "BYBIT", symbol: "BTCUSDT", timestamp: start + 864 * stepMs, receivedAt: start + 864 * stepMs + 250, liquidatedPositionSide: "SHORT", quantity: 9, bankruptcyPrice: 66_400, notional: 597_600, certainty: "OBSERVED", sourceVersion: rules.sourceVersion }
  ];
  const coverage: LiquidationCoverage = {
    venue: "BYBIT", symbol: "BTCUSDT", horizon: "3W", requestedStart: start, requestedEnd: now,
    availableStart: start, availableEnd: now, observedTradeCoveragePercent: 100, openInterestCoveragePercent: 100,
    liquidationEventCoveragePercent: 100, orderbookCoveragePercent: 100, modelContinuityPercent: 100,
    missingIntervals: [], quality: "EXCELLENT", state: "SYNTHETIC_TEST"
  };
  return { frames, events, rules, coverage };
}

/**
 * Localhost-only visual certification overlay. The underlying deterministic
 * model geometry remains intact; these narrow shelves guarantee that the
 * renderer golden exercises its teal/green ramp and a few rare yellow cores.
 * It is never reachable for production or browser-fallback market data.
 */
export function applyBclifVisualCertificationProfile(snapshot: LiquidationFieldSnapshot) {
  if (snapshot.authority !== "TEST_FIXTURE" || snapshot.certainty !== "SYNTHETIC_TEST") return snapshot;
  // Keep the fixture's naturally saturated model population in the teal ramp;
  // the explicit certification shelves below alone exercise green/yellow.
  const intensity = Uint8Array.from(snapshot.normalizedIntensity, (value) => Math.min(value, 251));
  const { columns, rows, minPrice, maxPrice } = snapshot.header;
  const priceStep = (maxPrice - minPrice) / Math.max(1, rows - 1);
  const bands = [
    { price: 60_850, from: 0.10, to: 0.70, cores: [0.45], center: 254 },
    { price: 64_650, from: 0.05, to: 1.00, cores: [0.61, 0.895, 0.95, 0.985], center: 254 },
    { price: 68_150, from: 0.30, to: 0.86, cores: [0.75], center: 254 }
  ];
  for (const band of bands) {
    const centerRow = Math.max(0, Math.min(rows - 1, Math.round((band.price - minPrice) / priceStep)));
    for (let column = 0; column < columns; column++) {
      const progress = column / Math.max(1, columns - 1);
      if (progress < band.from || progress > band.to) continue;
      const hot = band.cores.some((center) => Math.abs(progress - center) <= 0.5 / Math.max(1, columns - 1));
      const center = hot ? 255 : band.center;
      for (let offset = -3; offset <= 3; offset++) {
        const row = centerRow + offset;
        if (row < 0 || row >= rows) continue;
        const index = column * rows + row;
        if (!snapshot.validity[index]) continue;
        const target = center - [0, 1, 3, 5][Math.abs(offset)]!;
        intensity[index] = Math.max(intensity[index]!, target);
      }
    }
  }
  return {
    ...snapshot,
    normalizedIntensity: intensity,
    header: { ...snapshot.header, checksum: `${snapshot.header.checksum}:visual-certification-v3` }
  };
}

export function applyBclifVisualCase(snapshot: LiquidationFieldSnapshot, visualCase: BclifVisualCase): LiquidationFieldSnapshot {
  const checksum = `${snapshot.header.checksum}:clarity:${visualCase.toLowerCase()}`;
  if (visualCase === "MISSING_DATA") {
    const validity = snapshot.validity.slice();
    const startColumn = Math.floor(snapshot.header.columns * 0.42);
    const endColumn = Math.ceil(snapshot.header.columns * 0.54);
    for (let column = startColumn; column < endColumn; column++) {
      validity.fill(0, column * snapshot.header.rows, (column + 1) * snapshot.header.rows);
    }
    const gapStart = snapshot.timestamps[startColumn] ?? snapshot.header.startTime;
    const gapEnd = snapshot.timestamps[Math.min(snapshot.header.columns - 1, endColumn)] ?? snapshot.header.endTime;
    return {
      ...snapshot,
      validity,
      coverage: {
        ...snapshot.coverage,
        modelContinuityPercent: 88,
        quality: "MIXED" as const,
        missingIntervals: [{ start: gapStart, end: gapEnd }]
      },
      confidenceBreakdown: {
        ...snapshot.confidenceBreakdown,
        total: Math.min(68, snapshot.confidenceBreakdown.total),
        continuity: 88,
        penalties: [...snapshot.confidenceBreakdown.penalties, "DETERMINISTIC_VISUAL_GAP"]
      },
      header: { ...snapshot.header, checksum }
    };
  }
  if (visualCase === "BROWSER_FALLBACK") {
    const confidence = new Uint8Array(snapshot.confidence.length).fill(Math.round(52 * 2.55));
    return {
      ...snapshot,
      authority: "BROWSER_FALLBACK" as const,
      collectorNodeId: null,
      certainty: "ESTIMATED_MEDIUM" as const,
      confidence,
      persistentCoverage: undefined,
      coverage: {
        ...snapshot.coverage,
        observedTradeCoveragePercent: 0,
        openInterestCoveragePercent: 93,
        liquidationEventCoveragePercent: 0,
        orderbookCoveragePercent: 0,
        modelContinuityPercent: 92,
        quality: "MIXED" as const,
        state: "COLLECTING" as const
      },
      confidenceBreakdown: {
        ...snapshot.confidenceBreakdown,
        total: 52,
        tradeCoverage: 0,
        openInterest: 93,
        eventCalibration: 0,
        continuity: 92,
        penalties: ["BROWSER_SESSION_NO_PERSISTENT_EVENT_HISTORY"]
      },
      header: snapshot.header
    };
  }
  if (visualCase === "PERSISTENT_NODE") {
    const confidence = Uint8Array.from(snapshot.confidence, (value) => Math.max(value, 230));
    return {
      ...snapshot,
      authority: "PERSISTENT_NODE" as const,
      collectorNodeId: "LIQUIDATION_INTELLIGENCE_NODE_01",
      certainty: "ESTIMATED_HIGH" as const,
      confidence,
      coverage: { ...snapshot.coverage, quality: "EXCELLENT" as const, state: "LIVE" as const },
      persistentCoverage: {
        venue: "BYBIT",
        symbol: "BTCUSDT",
        horizon: "3W",
        requestedStart: snapshot.header.startTime,
        requestedEnd: snapshot.header.endTime,
        modelStart: snapshot.header.startTime,
        modelEnd: snapshot.header.endTime,
        openInterestCoveragePercent: 100,
        tradeCoveragePercent: 100,
        liquidationCoveragePercent: 100,
        orderbookCoveragePercent: 100,
        fundingCoveragePercent: 100,
        continuityPercent: 100,
        sourceMode: "PERSISTENT_COLLECTOR",
        quality: "EXCELLENT",
        gaps: [],
        updatedAt: snapshot.generatedAt
      },
      confidenceBreakdown: {
        ...snapshot.confidenceBreakdown,
        total: 91,
        tradeCoverage: 100,
        openInterest: 100,
        eventCalibration: 100,
        continuity: 100,
        penalties: []
      },
      header: snapshot.header
    };
  }
  return snapshot;
}

export function createBclifVisualChartCandles(count: number, timeframeSeconds: number): Candle[] {
  const length = Math.max(600, Math.min(5_000, Math.round(count)));
  const step = Math.max(60, Math.round(timeframeSeconds));
  return Array.from({ length }, (_, index) => {
    const time = BCLIF_VISUAL_FIXTURE_END_SECONDS - (length - 1 - index) * step;
    const trend = index < length * 0.4
      ? index * 1.7
      : index < length * 0.72
        ? length * 0.68 - (index - length * 0.4) * 2.15
        : (index - length * 0.72) * 0.95;
    const center = 63_350 + trend + Math.sin(index / 19) * 510 + Math.cos(index / 7.2) * 135;
    const open = center + Math.sin(index / 3.7) * 85;
    const close = center + Math.cos(index / 4.1) * 92;
    const wick = 120 + Math.abs(Math.sin(index / 11)) * 165;
    return {
      time,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick * 0.92,
      close,
      volume: 18_000 + (index % 37) * 730 + Math.abs(Math.sin(index / 13)) * 11_000
    };
  });
}
