import type {
  ConfirmedLiquidationEvent,
  LiquidationCoverage,
  LiquidationFieldSnapshot,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "../core/types.ts";
import type { LiquidationFieldSettings } from "../core/types.ts";
import { applyBclifPresentationPreset } from "../core/settings.ts";
import { buildCohortEntryDistribution } from "../core/entryDistribution.ts";
import type { Candle } from "../../../chart-engine/types.ts";

export const BCLIF_VISUAL_FIXTURE_END_SECONDS = 1_900_000_000;
export const BCLIF_VISUAL_FIXTURE_VERSION = "BCLIF_DETERMINISTIC_VISUAL_FIXTURE_V2_HIRES";

export const BCLIF_VISUAL_CASES = [
  "COHORT_PROVENANCE",
  "SWING_INDEPENDENCE",
  "OI_EXPANSION",
  "OI_CONTRACTION",
  "CONFIRMED_LIQUIDATION",
  "TRADE_FOCUS",
  "FULL_SPECTRUM_RESEARCH",
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
  const diagnosticSettings = (preset: "TRADE_FOCUS" | "FULL_SPECTRUM_RESEARCH") => ({
    ...applyBclifPresentationPreset(settings, preset),
    // Synthetic fixtures are intentionally unscored. Expose their complete
    // deterministic topology during localhost certification without lowering
    // the production confidence threshold or renderer authority rules.
    minimumConfidence: 0,
    minimumNotionalUsd: 0
  });
  if (visualCase === "FULL_SPECTRUM_RESEARCH") return diagnosticSettings("FULL_SPECTRUM_RESEARCH");
  if (visualCase === "COHORT_PROVENANCE") return {
    ...diagnosticSettings("TRADE_FOCUS"),
    cohortProvenanceVisible: true,
    cohortBirthMarkersVisible: true,
    diagnosticsVisible: true
  };
  if (["SWING_INDEPENDENCE", "OI_EXPANSION", "OI_CONTRACTION", "CONFIRMED_LIQUIDATION"].includes(visualCase)) {
    return {
      ...diagnosticSettings("TRADE_FOCUS"),
      cohortBirthMarkersVisible: true,
      confirmedMarkersVisible: visualCase === "CONFIRMED_LIQUIDATION",
      diagnosticsVisible: true
    };
  }
  return diagnosticSettings("TRADE_FOCUS");
}

export function createLiquidationFieldFixture(now = 1_900_000_000_000, visualCase?: BclifVisualCase) {
  const frameCount = 1_008;
  const stepMs = 30 * 60 * 1_000;
  const start = now - (frameCount - 1) * stepMs;
  const frames: LiquidationMarketFrame[] = [];
  let price = 64_000;
  let openInterest = 84_000;
  let cvd = 0;
  const expansionPlan = new Map<number, { delta: number; entry: number; shape: readonly [number, number, number] }>([
    [120, { delta: 420, entry: 62_800, shape: [0.22, 0.58, 0.2] }],
    [420, { delta: 680, entry: 65_400, shape: [0.12, 0.7, 0.18] }],
    [720, { delta: 510, entry: 67_200, shape: [0.3, 0.48, 0.22] }]
  ] as const);
  const forcedSwings = new Map<number, number>([
    [200, 70_000], [300, 59_500], [520, 72_000], [620, 60_000], [780, 73_000]
  ]);
  for (let index = 0; index < frameCount; index++) {
    const timestamp = start + index * stepMs;
    const phase = index / 4;
    const wave = Math.sin(phase / 15) * 180 + Math.sin(phase / 4.7) * 55;
    const regime = phase < 72 ? -phase * 3.2 : phase < 150 ? (phase - 72) * 4.4 : -(phase - 150) * 2.1;
    price = forcedSwings.get(index) ?? (64_000 + wave + regime);
    const plannedExpansion = expansionPlan.get(index);
    const expansionAllowed = visualCase !== "SWING_INDEPENDENCE"
      && (visualCase !== "OI_EXPANSION" || index === 120);
    const contractionAllowed = visualCase !== "SWING_INDEPENDENCE"
      && visualCase !== "OI_EXPANSION";
    const oiDelta = plannedExpansion && expansionAllowed
      ? plannedExpansion.delta
      : index === 840 && contractionAllowed
        ? -320
        : 0;
    openInterest = Math.max(40_000, openInterest + oiDelta);
    const buy = (5_000_000 + (Math.sin(phase / 9) + 1) * 1_200_000) / 4;
    const sell = (5_000_000 + (Math.cos(phase / 11) + 1) * 1_100_000) / 4;
    cvd += buy - sell;
    const intervalStart = index > 0 ? timestamp - stepMs : undefined;
    const intervalEnd = index > 0 ? timestamp : undefined;
    const entryDistribution = oiDelta > 0 && plannedExpansion && intervalStart !== undefined && intervalEnd !== undefined
      ? buildCohortEntryDistribution({
          observations: [
            { price: plannedExpansion.entry * 0.997, weight: plannedExpansion.shape[0] },
            { price: plannedExpansion.entry, weight: plannedExpansion.shape[1] },
            { price: plannedExpansion.entry * 1.003, weight: plannedExpansion.shape[2] }
          ],
          source: "EXACT_TRADES",
          intervalStart,
          intervalEnd,
          confidence: 0.95,
          fallbackPrice: plannedExpansion.entry
        })
      : undefined;
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
      oiIntervalStart: intervalStart,
      oiIntervalEnd: intervalEnd,
      entryDistribution,
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
        leveragePrior: "SYNTHETIC_TEST", marginModel: "SYNTHETIC_TEST",
        confirmedLiquidations: index === 780 ? "MISSING" : "SYNTHETIC_TEST",
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
  const allEvents: ConfirmedLiquidationEvent[] = [
    { id: "fixture-long", venue: "BYBIT", symbol: "BTCUSDT", timestamp: start + 760 * stepMs, receivedAt: start + 760 * stepMs + 250, liquidatedPositionSide: "LONG", quantity: 820, bankruptcyPrice: 61_850, notional: 50_706_000, certainty: "OBSERVED", sourceVersion: rules.sourceVersion },
    { id: "fixture-short", venue: "BYBIT", symbol: "BTCUSDT", timestamp: start + 864 * stepMs, receivedAt: start + 864 * stepMs + 250, liquidatedPositionSide: "SHORT", quantity: 460, bankruptcyPrice: 66_400, notional: 30_544_000, certainty: "OBSERVED", sourceVersion: rules.sourceVersion }
  ];
  const events = visualCase === "SWING_INDEPENDENCE" || visualCase === "OI_EXPANSION" || visualCase === "OI_CONTRACTION"
    ? []
    : allEvents;
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
  // Chapter III-C3 forbids test-only exposure painting. The visual golden is
  // now the direct output of the deterministic birth/death fixture.
  return snapshot;
}

export function applyBclifVisualCase(snapshot: LiquidationFieldSnapshot, visualCase: BclifVisualCase): LiquidationFieldSnapshot {
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
