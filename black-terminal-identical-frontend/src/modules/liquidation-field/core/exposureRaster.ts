import { performance } from "../testing/performanceClock.ts";
import { confidenceForFrame } from "./certainty.ts";
import { LiquidationCohortEngine } from "./cohortEngine.ts";
import { normalizeExposureCausal, smoothField } from "./normalization.ts";
import type {
  CascadeRiskSnapshot,
  ConfirmedLiquidationEvent,
  LiquidationCoverage,
  LiquidationExposureParticle,
  LiquidationFieldSettings,
  LiquidationFieldSnapshot,
  LiquidationInstrumentRules,
  LiquidationMarketFrame
} from "./types.ts";
import { BCLIF_MODEL_VERSION } from "./types.ts";
import { liquidationHorizonMs } from "./settings.ts";

export function outputFrameIndices(
  frames: readonly LiquidationMarketFrame[],
  settings: Pick<LiquidationFieldSettings, "horizon" | "customHours" | "timeColumns">
) {
  // A fixed UTC time lattice makes down-sampling append-stable. Selecting
  // columns from the eventual frame count would allow a future append to
  // choose different historical frames and repaint the past.
  // Reserve one column for a UTC bucket-edge crossing so an arbitrarily
  // aligned requested window still respects the configured GPU column bound.
  const bucketMs = Math.max(1, Math.ceil(liquidationHorizonMs(settings) / Math.max(1, settings.timeColumns - 1)));
  const indices = new Set<number>();
  let previousBucket: number | null = null;
  for (let index = 0; index < frames.length; index++) {
    const bucket = Math.floor(frames[index]!.timestamp / bucketMs);
    if (bucket === previousBucket) continue;
    indices.add(index);
    previousBucket = bucket;
  }
  return indices;
}

function gaussianKernel(distance: number, sigma: number) {
  const safeSigma = Math.max(1e-9, sigma);
  return Math.exp(-0.5 * (distance / safeSigma) ** 2) / (safeSigma * Math.sqrt(2 * Math.PI));
}

function checksum(values: Float32Array) {
  let hash = 0x811c9dc5;
  const view = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  for (let index = 0; index < view.length; index += Math.max(1, Math.floor(view.length / 4_096))) {
    hash ^= view[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

function depthCapacity(frame: LiquidationMarketFrame, direction: "UP" | "DOWN") {
  const curve = direction === "UP" ? frame.askDepthCurve : frame.bidDepthCurve;
  return curve.points.reduce((sum, point) => sum + point.notional, 0);
}

function buildCascade(
  frame: LiquidationMarketFrame,
  particles: LiquidationExposureParticle[],
  priceStep: number
): CascadeRiskSnapshot[] {
  const byDirection: Array<{ direction: "UP" | "DOWN"; side: "SHORT" | "LONG" }> = [
    { direction: "UP", side: "SHORT" },
    { direction: "DOWN", side: "LONG" }
  ];
  return byDirection.map(({ direction, side }) => {
    const relevant = particles
      .filter((particle) => particle.side === side && particle.notional > 0)
      .sort((a, b) => Math.abs(a.liquidationPrice - frame.markPrice) - Math.abs(b.liquidationPrice - frame.markPrice));
    const trigger = relevant[0];
    const next = relevant.find((particle) => trigger && Math.abs(particle.liquidationPrice - trigger.liquidationPrice) > priceStep * 3);
    const forced = trigger ? trigger.notional * trigger.survival * trigger.weight : 0;
    const absorption = depthCapacity(frame, direction);
    const observedDepth = (direction === "UP" ? frame.askDepthCurve : frame.bidDepthCurve).certainty === "OBSERVED";
    const ratio = forced > 0 && observedDepth ? forced / Math.max(1, absorption) : 0;
    const probability = observedDepth
      ? Math.max(0, Math.min(1, 1 - Math.exp(-ratio * (1 + frame.realizedVolatility * 12))))
      : 0;
    const triggerPrice = trigger?.liquidationPrice ?? frame.markPrice;
    return {
      timestamp: frame.timestamp,
      symbol: frame.symbol,
      direction,
      triggerRange: [triggerPrice - priceStep, triggerPrice + priceStep],
      nextClusterRange: next ? [next.liquidationPrice - priceStep, next.liquidationPrice + priceStep] : null,
      estimatedForcedNotional: forced,
      estimatedAbsorptionCapacity: absorption,
      estimatedSlippageBps: ratio * Math.max(1, frame.spreadBps),
      cascadeProbability: probability,
      confidence: Math.min(trigger?.confidence ?? 0, frame.bidDepthCurve.certainty === "OBSERVED" ? 0.85 : 0.25),
      state: probability >= 0.82 ? "ARMED" : probability >= 0.55 ? "BUILDING" : "DORMANT"
    };
  });
}

export function buildLiquidationFieldSnapshot(
  sourceFrames: readonly LiquidationMarketFrame[],
  sourceEvents: readonly ConfirmedLiquidationEvent[],
  rules: LiquidationInstrumentRules,
  settings: LiquidationFieldSettings,
  coverage: LiquidationCoverage
): LiquidationFieldSnapshot {
  const started = performance.now();
  const frames = [...sourceFrames].sort((a, b) => a.timestamp - b.timestamp);
  if (!frames.length) throw new Error("BCLIF requires at least one canonical market frame");
  const events = [...sourceEvents].sort((a, b) => a.timestamp - b.timestamp);
  const selectedIndices = outputFrameIndices(frames, settings);
  // Anchor the price lattice to information available at the first source
  // cutoff. Using the eventual range of the full replay would let a future
  // price extreme move every earlier raster row.
  const anchorFrame = frames[0]!;
  const minimumObserved = Math.min(anchorFrame.markPrice, anchorFrame.lastPrice);
  const maximumObserved = Math.max(anchorFrame.markPrice, anchorFrame.lastPrice);
  const leverageEnvelope = Math.max(0.08, Math.min(0.52, 1 / Math.max(2, settings.leverageMinimum) + 0.025));
  const minPrice = Math.max(1e-8, minimumObserved * (1 - leverageEnvelope));
  const maxPrice = maximumObserved * (1 + leverageEnvelope);
  const rows = settings.priceRows;
  const priceStep = (maxPrice - minPrice) / Math.max(1, rows - 1);
  const columns = selectedIndices.size;
  const longExposure = new Float32Array(columns * rows);
  const shortExposure = new Float32Array(columns * rows);
  const confidence = new Uint8Array(columns * rows);
  const validity = new Uint8Array(columns * rows);
  const confirmedIntensity = new Uint8Array(columns * rows);
  const confirmedNotional = new Float32Array(columns * rows);
  const confirmedCount = new Uint16Array(columns * rows);
  const timestamps = new Float64Array(columns);
  const cohortEngine = new LiquidationCohortEngine(rules, settings.modelPreset);
  let column = 0;
  let latestState = cohortEngine.snapshot();
  let latestConfidence = confidenceForFrame(frames[0]!);

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex]!;
    latestState = cohortEngine.processFrame(frame, events);
    if (!selectedIndices.has(frameIndex)) continue;
    latestConfidence = confidenceForFrame(frame);
    timestamps[column] = frame.timestamp;
    const columnStart = column * rows;
    const frameIsValid = frame.certainty.openInterest !== "UNAVAILABLE"
      && frame.certainty.openInterest !== "MISSING";
    for (let row = 0; row < rows; row++) {
      const index = columnStart + row;
      validity[index] = frameIsValid ? 255 : 0;
      confidence[index] = Math.round(latestConfidence.total * 2.55);
    }
    if (frameIsValid) rasterizeParticles(
      latestState.particles,
      longExposure,
      shortExposure,
      columnStart,
      rows,
      minPrice,
      priceStep,
      settings
    );
    rasterizeConfirmedEvents(
      events,
      confirmedIntensity,
      confirmedNotional,
      confirmedCount,
      frame,
      columnStart,
      rows,
      minPrice,
      priceStep
    );
    column += 1;
  }

  const rawCombined = new Float32Array(longExposure.length);
  for (let index = 0; index < rawCombined.length; index++) rawCombined[index] = longExposure[index]! + shortExposure[index]!;
  const combinedExposure = settings.smoothing === "SHARP"
    ? rawCombined
    : smoothField(
        rawCombined,
        validity,
        columns,
        rows,
        settings.timeSigmaColumns,
        settings.priceSigmaRows
      );
  const normalizationConfidence = coverage.state === "SYNTHETIC_TEST"
    ? new Uint8Array(confidence.length).fill(255)
    : confidence;
  const { normalized, high } = normalizeExposureCausal(
    combinedExposure,
    normalizationConfidence,
    validity,
    columns,
    rows,
    settings
  );
  const { normalized: longNormalizedIntensity } = normalizeExposureCausal(
    longExposure,
    normalizationConfidence,
    validity,
    columns,
    rows,
    settings
  );
  const { normalized: shortNormalizedIntensity } = normalizeExposureCausal(
    shortExposure,
    normalizationConfidence,
    validity,
    columns,
    rows,
    settings
  );
  const lastFrame = frames.at(-1)!;
  const cascade = buildCascade(lastFrame, latestState.particles, priceStep);
  const buildTimeMs = performance.now() - started;

  return {
    header: {
      schemaVersion: 1,
      modelVersion: BCLIF_MODEL_VERSION,
      venue: lastFrame.venue,
      symbol: lastFrame.symbol,
      horizon: settings.horizon,
      startTime: timestamps[0]!,
      endTime: timestamps.at(-1)!,
      minPrice,
      maxPrice,
      columns,
      rows,
      timeStepMs: columns > 1 ? Math.max(1, (timestamps.at(-1)! - timestamps[0]!) / (columns - 1)) : 1,
      priceStep,
      exposureScale: Math.expm1(high),
      confidenceScale: 255,
      compression: "rgba8-gpu-v1",
      checksum: checksum(combinedExposure)
    },
    timestamps,
    longExposure,
    shortExposure,
    combinedExposure,
    normalizedIntensity: normalized,
    longNormalizedIntensity,
    shortNormalizedIntensity,
    confidence,
    validity,
    confirmedIntensity,
    confirmedNotional,
    confirmedCount,
    cohorts: latestState.cohorts,
    confirmedEvents: events.filter((event) => event.timestamp >= timestamps[0]! && event.timestamp <= timestamps.at(-1)!),
    cascade,
    coverage,
    confidenceBreakdown: latestConfidence,
    buildTimeMs,
    generatedAt: Date.now(),
    authority: coverage.state === "SYNTHETIC_TEST" ? "TEST_FIXTURE" : "BROWSER_FALLBACK",
    collectorNodeId: null,
    certainty: coverage.state === "SYNTHETIC_TEST"
      ? "SYNTHETIC_TEST"
      : latestConfidence.total >= 80
        ? "ESTIMATED_HIGH"
        : latestConfidence.total >= 60
          ? "ESTIMATED_MEDIUM"
          : "ESTIMATED_LOW"
  };
}

function rasterizeParticles(
  particles: readonly LiquidationExposureParticle[],
  longExposure: Float32Array,
  shortExposure: Float32Array,
  columnStart: number,
  rows: number,
  minPrice: number,
  priceStep: number,
  settings: LiquidationFieldSettings
) {
  for (const particle of particles) {
    if (particle.leverage < settings.leverageMinimum || particle.leverage > settings.leverageMaximum) continue;
    if (settings.sideFilter === "LONG" && particle.side !== "LONG") continue;
    if (settings.sideFilter === "SHORT" && particle.side !== "SHORT") continue;
    const effectiveNotional = particle.notional * particle.survival * particle.weight;
    if (effectiveNotional < settings.minimumNotionalUsd) continue;
    // Confidence is encoded separately and applied by the renderer. Filtering
    // here would turn honest low-confidence historical coverage into a false
    // blank field rather than a visibly muted estimate.
    const center = Math.round((particle.liquidationPrice - minPrice) / priceStep);
    const sigmaRows = Math.max(0.75, particle.liquidationStdDev / Math.max(1e-9, priceStep));
    const radius = Math.min(rows, Math.max(2, Math.ceil(sigmaRows * 3)));
    const target = particle.side === "LONG" ? longExposure : shortExposure;
    for (let offset = -radius; offset <= radius; offset++) {
      const row = center + offset;
      if (row < 0 || row >= rows) continue;
      const kernel = gaussianKernel(offset, sigmaRows);
      const targetIndex = columnStart + row;
      target[targetIndex] = (target[targetIndex] ?? 0) + effectiveNotional * particle.confidence * kernel;
    }
  }
}

function rasterizeConfirmedEvents(
  events: readonly ConfirmedLiquidationEvent[],
  intensityTarget: Uint8Array,
  notionalTarget: Float32Array,
  countTarget: Uint16Array,
  frame: LiquidationMarketFrame,
  columnStart: number,
  rows: number,
  minPrice: number,
  priceStep: number
) {
  const previousBoundary = frame.timestamp - 15 * 60 * 1_000;
  const relevant = events.filter((event) => {
    const knownAt = Math.max(event.timestamp, event.receivedAt);
    return knownAt > previousBoundary && knownAt <= frame.timestamp;
  });
  if (!relevant.length) return;
  const maximum = Math.max(...relevant.map((event) => event.notional), 1);
  for (const event of relevant) {
    const center = Math.round((event.bankruptcyPrice - minPrice) / priceStep);
    for (let offset = -2; offset <= 2; offset++) {
      const row = center + offset;
      if (row < 0 || row >= rows) continue;
      const index = columnStart + row;
      const kernel = Math.exp(-(offset * offset) / 2);
      const intensity = Math.round(255 * Math.sqrt(event.notional / maximum) * kernel);
      intensityTarget[index] = Math.max(intensityTarget[index]!, intensity);
      notionalTarget[index] = notionalTarget[index]! + event.notional * kernel;
      countTarget[index] = Math.min(65_535, countTarget[index]! + 1);
    }
  }
}
