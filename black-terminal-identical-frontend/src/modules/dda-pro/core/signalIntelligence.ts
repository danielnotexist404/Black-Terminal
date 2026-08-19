import type { Candle } from "../../../chart-engine/types.ts";
import type {
  DDAProCalculationInput,
  DDAProDistributionRegime,
  DDAProSeries,
  DDAProSettings,
  DDAProSignalDirection,
  DDAProSignalEpisode,
  DDAProSignalEvent,
  DDAProSignalIntelligence,
  DDAProSignalReason,
  DDAProSignalState
} from "./types.ts";

export const DDA_PRO_SIGNAL_INTELLIGENCE_VERSION = "BC_RDA_SIGNAL_INTELLIGENCE_V1" as const;
export const DDA_PRO_MAX_SIGNAL_EPISODES = 512;
export const DDA_PRO_MAX_PROVISIONAL_SIGNALS = 2_048;

const clamp = (value: number, minimum = 0, maximum = 100) => Math.max(minimum, Math.min(maximum, value));
const finite = (value: number | undefined, fallback = 0) => Number.isFinite(value) ? Number(value) : fallback;
const average = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

type DirectionRuntime = {
  state: DDAProSignalState;
  lastConfirmedIndex: number;
  lastConfirmedCentroid: number;
  resetObserved: boolean;
  episode: DDAProSignalEpisode | null;
};

type FeatureFrame = {
  centroid: number;
  width: number;
  coherence: number;
  centroidVelocity: number;
  centroidAcceleration: number;
  expansion: number;
  tail: number;
  signedTail: number;
  entropy: number;
  chop: number;
  longConfidence: number;
  shortConfidence: number;
  regime: DDAProDistributionRegime;
  regimeConfidence: number;
};

function rawIntelligence(length: number, rawSignals: readonly DDAProSignalEvent[]): DDAProSignalIntelligence {
  return {
    engineVersion: DDA_PRO_SIGNAL_INTELLIGENCE_VERSION,
    mode: "RAW",
    regime: new Array(length).fill("UNCLASSIFIED"),
    regimeConfidence: new Array(length).fill(0),
    longConfidence: new Array(length).fill(0),
    shortConfidence: new Array(length).fill(0),
    chopProbability: new Array(length).fill(0),
    transitionEntropy: new Array(length).fill(0),
    coherence: new Array(length).fill(0),
    centroidVelocity: new Array(length).fill(0),
    centroidAcceleration: new Array(length).fill(0),
    expansionScore: new Array(length).fill(0),
    tailAsymmetry: new Array(length).fill(0),
    state: new Array(length).fill("NEUTRAL"),
    longState: new Array(length).fill("NEUTRAL"),
    shortState: new Array(length).fill("NEUTRAL"),
    rawCandidateSignals: rawSignals.map((signal) => ({ ...signal })),
    episodes: [],
    provisionalSignals: [],
    suppressedRawSignalCount: 0,
    latestReasonCodes: []
  };
}

function bandValues(series: DDAProSeries, index: number) {
  return [series.p05, series.p10, series.p25, series.p50, series.p75, series.p90, series.p95, series.p99]
    .map((values) => values[index])
    .filter((value): value is number => Number.isFinite(value));
}

function directionalPersistence(velocities: readonly number[], index: number, direction: DDAProSignalDirection, bars: number) {
  const expected = direction === "long" ? -1 : 1;
  let count = 0;
  for (let cursor = index; cursor >= 0 && count < bars; cursor--) {
    const value = velocities[cursor] ?? 0;
    if (Math.abs(value) < 1e-9 || Math.sign(value) !== expected) break;
    count += 1;
  }
  return count;
}

function priceStructureConfirmed(candles: readonly Candle[], index: number, direction: DDAProSignalDirection, strength: number) {
  const bars = Math.max(2, Math.min(12, Math.round(2 + strength / 20)));
  if (index < bars) return false;
  const current = candles[index]!;
  const prior = candles.slice(index - bars, index);
  const range = Math.max(...prior.map((candle) => candle.high)) - Math.min(...prior.map((candle) => candle.low));
  if (!(range > 0)) return false;
  const displacement = (current.close - (prior[0]?.close ?? current.close)) / range;
  const threshold = 0.08 + strength / 500;
  const bodyEfficiency = (current.close - current.open) / Math.max(1e-12, current.high - current.low);
  return direction === "long"
    ? displacement >= threshold || bodyEfficiency >= threshold
    : displacement <= -threshold || bodyEfficiency <= -threshold;
}

function volumeConfirmed(candles: readonly Candle[], index: number) {
  const start = Math.max(0, index - 20);
  const history = candles.slice(start, index).map((candle) => candle.volume).filter((value) => Number.isFinite(value) && value > 0);
  if (!history.length) return false;
  return finite(candles[index]?.volume) >= average(history) * 0.9;
}

export function completedHigherTimeframeDirections(input: DDAProCalculationInput) {
  const baseSeconds = Math.max(1, input.timeframeSeconds ?? 1);
  const higherSeconds = baseSeconds * input.settings.higherTimeframeMultiplier;
  const directions = new Array<number>(input.candles.length).fill(0);
  const observedBuckets = new Map<number, number>();
  const completedCloses: number[] = [];
  for (let index = 0; index < input.candles.length; index++) {
    const candle = input.candles[index]!;
    const bucket = Math.floor(candle.time / higherSeconds) * higherSeconds;
    observedBuckets.set(bucket, candle.close);
    const closedAt = candle.time + baseSeconds;
    const closable = [...observedBuckets.entries()]
      .filter(([start]) => start + higherSeconds <= closedAt)
      .sort((left, right) => left[0] - right[0]);
    for (const [start, close] of closable) {
      completedCloses.push(close);
      observedBuckets.delete(start);
    }
    if (completedCloses.length >= 2) directions[index] = Math.sign(completedCloses.at(-1)! - completedCloses.at(-2)!);
  }
  return directions;
}

export function completedHigherTimeframeDirection(input: DDAProCalculationInput, index: number) {
  return completedHigherTimeframeDirections(input)[index] ?? 0;
}

function canonicalSignalId(input: DDAProCalculationInput, signal: DDAProSignalEvent, mode: DDAProSettings["signalIntelligenceMode"]) {
  const clean = (value: string) => value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "unknown";
  const context = input.signalContext;
  const barClose = signal.time + Math.max(1, input.timeframeSeconds ?? 1);
  return ["bc-rda-intel-v1", clean(context?.exchange ?? "market"), clean(context?.symbol ?? "unknown"), clean(context?.timeframe ?? `${input.timeframeSeconds ?? 0}s`), barClose, signal.direction, mode.toLowerCase()].join(":");
}

function featureFrames(series: DDAProSeries, rawSignals: readonly DDAProSignalEvent[], settings: DDAProSettings) {
  const length = series.rawDrawdown.length;
  const rawByIndex = new Map<number, DDAProSignalEvent[]>();
  for (const signal of rawSignals) rawByIndex.set(signal.index, [...(rawByIndex.get(signal.index) ?? []), signal]);
  const frames: FeatureFrame[] = [];
  const centroids = new Array<number>(length).fill(0);
  const widths = new Array<number>(length).fill(0);
  const velocities = new Array<number>(length).fill(0);
  let widthBaseline = 0;
  let rawWindowCount = 0;
  const entropyWindow = 12;
  for (let index = 0; index < length; index++) {
    const bands = bandValues(series, index);
    const centroid = bands.length ? average(bands) : finite(series.mean[index]);
    const width = bands.length > 1 ? Math.max(...bands) - Math.min(...bands) : 0;
    centroids[index] = centroid;
    widths[index] = Math.max(0, width);
    const previousCentroid = centroids[index - 1] ?? centroid;
    const previousWidth = widths[index - 1] ?? width;
    widthBaseline = index === 0 ? width : widthBaseline * 0.92 + width * 0.08;
    const normalizationWidth = Math.max(0.000_001, width, widthBaseline);
    const velocity = (centroid - previousCentroid) / normalizationWidth;
    const centroidAcceleration = velocity - (velocities[index - 1] ?? velocity);
    velocities[index] = velocity;

    const previousBands = index > 0 ? bandValues(series, index - 1) : bands;
    const slopes = bands.map((value, bandIndex) => value - finite(previousBands[bandIndex], value));
    const nonZeroSlopes = slopes.filter((value) => Math.abs(value) > normalizationWidth * 0.0005);
    const coherence = nonZeroSlopes.length
      ? clamp(Math.abs(nonZeroSlopes.reduce((sum, value) => sum + Math.sign(value), 0)) / nonZeroSlopes.length * 100)
      : 0;
    const widthRatio = widthBaseline > 1e-9 ? width / widthBaseline : 1;
    const widthVelocity = (width - previousWidth) / normalizationWidth;
    const expansion = clamp(50 + (widthRatio - 1) * 55 + widthVelocity * 95);
    const halfWidth = Math.max(width / 2, 0.000_001);
    const signedTail = clamp((finite(series.smoothedDrawdown[index]) - centroid) / halfWidth * 50, -100, 100);
    const tail = Math.abs(signedTail);

    const start = Math.max(1, index - entropyWindow + 1);
    const signs = velocities.slice(start, index + 1).map((value) => Math.abs(value) < 0.002 ? 0 : Math.sign(value));
    let switches = 0;
    let comparable = 0;
    for (let cursor = 1; cursor < signs.length; cursor++) {
      if (signs[cursor] === 0 || signs[cursor - 1] === 0) continue;
      comparable += 1;
      if (signs[cursor] !== signs[cursor - 1]) switches += 1;
    }
    rawWindowCount += rawByIndex.get(index)?.length ?? 0;
    rawWindowCount -= rawByIndex.get(index - entropyWindow)?.length ?? 0;
    const rawDensity = rawWindowCount;
    const entropy = clamp((comparable ? switches / comparable : 0) * 72 + Math.min(1, rawDensity / 4) * 28);
    const chop = clamp(entropy * 0.55 + (100 - coherence) * 0.30 + (100 - expansion) * 0.15);
    const movementLong = clamp(-velocity / Math.max(0.005, settings.minimumCentroidDisplacement) * 35 - centroidAcceleration / Math.max(0.005, settings.minimumCentroidDisplacement) * 10);
    const movementShort = clamp(velocity / Math.max(0.005, settings.minimumCentroidDisplacement) * 35 + centroidAcceleration / Math.max(0.005, settings.minimumCentroidDisplacement) * 10);
    const longTail = clamp(-signedTail);
    const shortTail = clamp(signedTail);
    const longConfidence = clamp(coherence * 0.22 + movementLong * 0.20 + expansion * 0.17 + longTail * 0.20 + (100 - chop) * 0.21);
    const shortConfidence = clamp(coherence * 0.22 + movementShort * 0.20 + expansion * 0.17 + shortTail * 0.20 + (100 - chop) * 0.21);
    const hasRawSignal = rawByIndex.has(index);
    let regime: DDAProDistributionRegime = "TRANSITION";
    if (bands.length < 4) regime = "UNCLASSIFIED";
    else if (chop > settings.maximumChopProbability) regime = "CHOP";
    else if (expansion < 35) regime = "COMPRESSION";
    else if (tail > 78 && expansion < (frames[index - 1]?.expansion ?? expansion)) regime = "EXHAUSTION";
    else if (coherence >= settings.minimumCoherence && expansion >= settings.minimumExpansionScore && Math.abs(velocity) >= settings.minimumCentroidDisplacement) regime = "DIRECTIONAL_EXPANSION";
    else if (hasRawSignal) regime = "REDISTRIBUTION";
    const regimeConfidence = regime === "CHOP" ? chop
      : regime === "COMPRESSION" ? 100 - expansion
        : regime === "DIRECTIONAL_EXPANSION" ? average([coherence, expansion, clamp(Math.abs(velocity) * 300)])
          : regime === "EXHAUSTION" ? average([tail, 100 - expansion])
            : Math.max(longConfidence, shortConfidence);
    frames.push({ centroid, width, coherence, centroidVelocity: velocity, centroidAcceleration, expansion, tail, signedTail, entropy, chop, longConfidence, shortConfidence, regime, regimeConfidence: clamp(regimeConfidence) });
  }
  return { frames, velocities };
}

function reasonsForFrame(frame: FeatureFrame, settings: DDAProSettings): DDAProSignalReason[] {
  const reasons: DDAProSignalReason[] = [];
  if (frame.coherence < settings.minimumCoherence) reasons.push("LOW_COHERENCE");
  if (frame.entropy > settings.maximumTransitionEntropy) reasons.push("HIGH_TRANSITION_ENTROPY");
  if (frame.chop > settings.maximumChopProbability) reasons.push("HIGH_CHOP_PROBABILITY");
  if (Math.abs(frame.centroidVelocity) < settings.minimumCentroidDisplacement) reasons.push("CENTROID_STALLED");
  else reasons.push(frame.centroidVelocity > 0 ? "CENTROID_MIGRATING_UP" : "CENTROID_MIGRATING_DOWN");
  if (frame.expansion < settings.minimumExpansionScore) reasons.push("DISTRIBUTION_COMPRESSED");
  else reasons.push("DISTRIBUTION_EXPANDING");
  if (frame.signedTail > settings.minimumTailAsymmetry) reasons.push("UPPER_TAIL_DOMINANT");
  if (frame.signedTail < -settings.minimumTailAsymmetry) reasons.push("LOWER_TAIL_DOMINANT");
  return reasons;
}

export function applyDDAProSignalIntelligence(
  input: DDAProCalculationInput,
  series: DDAProSeries,
  rawSignals: readonly DDAProSignalEvent[]
): { signals: DDAProSignalEvent[]; rawSignals: DDAProSignalEvent[]; intelligence: DDAProSignalIntelligence } {
  const settings = input.settings;
  const raw = rawSignals.map((signal) => ({ ...signal }));
  if (settings.signalIntelligenceMode === "RAW") return { signals: raw, rawSignals: raw, intelligence: rawIntelligence(series.rawDrawdown.length, raw) };

  const { frames, velocities } = featureFrames(series, raw, settings);
  const higherTimeframeDirections = settings.higherTimeframeConfirmation ? completedHigherTimeframeDirections(input) : null;
  const confirmed: DDAProSignalEvent[] = [];
  const provisional: DDAProSignalEvent[] = [];
  const state = new Array<DDAProSignalState>(series.rawDrawdown.length).fill("NEUTRAL");
  const longState = new Array<DDAProSignalState>(series.rawDrawdown.length).fill("NEUTRAL");
  const shortState = new Array<DDAProSignalState>(series.rawDrawdown.length).fill("NEUTRAL");
  const episodes: DDAProSignalEpisode[] = [];
  const rawByIndex = new Map<number, DDAProSignalEvent[]>();
  for (const signal of raw) rawByIndex.set(signal.index, [...(rawByIndex.get(signal.index) ?? []), signal]);
  const runtimes: Record<DDAProSignalDirection, DirectionRuntime> = {
    long: { state: "NEUTRAL", lastConfirmedIndex: -1_000_000, lastConfirmedCentroid: 0, resetObserved: true, episode: null },
    short: { state: "NEUTRAL", lastConfirmedIndex: -1_000_000, lastConfirmedCentroid: 0, resetObserved: true, episode: null }
  };
  let suppressed = 0;
  const statePriority: Record<DDAProSignalState, number> = { NEUTRAL: 0, WATCHING: 1, ARMED: 2, RESET: 3, COOLDOWN: 4, CONFIRMED: 5 };

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    const confirmedDirections = new Set<DDAProSignalDirection>();
    let barState: DDAProSignalState = "NEUTRAL";
    for (const direction of ["long", "short"] as const) {
      const runtime = runtimes[direction];
      const barsSince = index - runtime.lastConfirmedIndex;
      const normalizedSeparation = runtime.lastConfirmedIndex >= 0
        ? Math.abs(frame.centroid - runtime.lastConfirmedCentroid) / Math.max(frame.width, 0.000_001)
        : Number.POSITIVE_INFINITY;
      const directionReversed = direction === "long" ? frame.centroidVelocity > 0 : frame.centroidVelocity < 0;
      const centroidQuiet = Math.abs(frame.centroidVelocity) < Math.max(0.002, settings.minimumCentroidDisplacement * 0.35);
      const neutralized = frame.tail <= settings.resetSensitivity * 0.5 && frame.chop < settings.maximumChopProbability && (centroidQuiet || directionReversed);
      const resetRegime = frame.regime === "COMPRESSION" || frame.regime === "CHOP" || frame.regime === "EXHAUSTION";
      const materiallyReorganized = normalizedSeparation >= settings.episodeSeparationSensitivity && (directionReversed || resetRegime);
      if (runtime.state === "COOLDOWN" && barsSince >= settings.safetyCooldownFloor && (neutralized || materiallyReorganized)) {
        runtime.state = "RESET";
        runtime.resetObserved = true;
        if (runtime.episode) runtime.episode.resetIndex = index;
        runtime.episode = null;
      }
      if (runtime.state === "RESET") runtime.state = "NEUTRAL";
      if (runtime.state !== "COOLDOWN") {
        const directionalConfidence = direction === "long" ? frame.longConfidence : frame.shortConfidence;
        const migrationAligned = direction === "long" ? frame.centroidVelocity < 0 : frame.centroidVelocity > 0;
        const organized = frame.chop <= settings.maximumChopProbability && frame.entropy <= settings.maximumTransitionEntropy;
        runtime.state = directionalConfidence >= settings.minimumConfirmationScore && migrationAligned && organized
          ? "ARMED"
          : directionalConfidence >= Math.max(0, settings.minimumConfirmationScore - 15) ? "WATCHING" : "NEUTRAL";
      }
      if (statePriority[runtime.state] > statePriority[barState]) barState = runtime.state;
    }

    for (const rawSignal of rawByIndex.get(index) ?? []) {
      const direction = rawSignal.direction;
      const runtime = runtimes[direction];
      const confidence = direction === "long" ? frame.longConfidence : frame.shortConfidence;
      const expectedVelocity = direction === "long" ? frame.centroidVelocity < 0 : frame.centroidVelocity > 0;
      const expectedTail = direction === "long" ? frame.signedTail <= -settings.minimumTailAsymmetry : frame.signedTail >= settings.minimumTailAsymmetry;
      const centroidPersistence = directionalPersistence(velocities, index, direction, settings.minimumCentroidPersistence);
      const excursionPersistence = directionalPersistence(velocities, index, direction, settings.minimumExcursionBars);
      const centroidConfirmed = expectedVelocity && Math.abs(frame.centroidVelocity) >= settings.minimumCentroidDisplacement && centroidPersistence >= settings.minimumCentroidPersistence;
      const nativeDirectionalConfirmationIsAlternative = settings.signalIntelligenceMode !== "CUSTOM" && settings.riskCentroidMigration && settings.tailAsymmetryConfirmation;
      const reasons = reasonsForFrame(frame, settings);
      let accepted = true;
      if (settings.signalEpisodeClustering && runtime.state === "COOLDOWN" && !runtime.resetObserved) { accepted = false; reasons.push("EPISODE_ALREADY_SIGNALLED"); }
      if (settings.distributionalResetRequirement && !runtime.resetObserved) { accepted = false; reasons.push("RESET_NOT_CONFIRMED"); }
      if (settings.distributionCoherenceFilter && frame.coherence < settings.minimumCoherence) accepted = false;
      if (nativeDirectionalConfirmationIsAlternative) {
        if (!centroidConfirmed && !expectedTail) accepted = false;
      } else {
        if (settings.riskCentroidMigration && !centroidConfirmed) accepted = false;
        if (settings.tailAsymmetryConfirmation && !expectedTail) accepted = false;
      }
      if (settings.riskCentroidMigration && centroidPersistence < settings.minimumCentroidPersistence) reasons.push("EXCURSION_NOT_PERSISTENT");
      if (settings.tailAsymmetryConfirmation && !expectedTail) reasons.push("TAIL_ASYMMETRY_WEAK");
      if (settings.distributionExpansionConfirmation && frame.expansion < settings.minimumExpansionScore) accepted = false;
      if (settings.entropyChopSuppression && (frame.chop > settings.maximumChopProbability || frame.entropy > settings.maximumTransitionEntropy)) {
        accepted = false;
        if (frame.chop > settings.maximumChopProbability) reasons.push("HIGH_CHOP_PROBABILITY");
      }
      if (settings.excursionPersistence && excursionPersistence < settings.minimumExcursionBars) { accepted = false; reasons.push("EXCURSION_NOT_PERSISTENT"); }
      if (settings.priceStructureConfirmation && !priceStructureConfirmed(input.candles, index, direction, settings.structureConfirmationStrength)) { accepted = false; reasons.push("STRUCTURE_NOT_CONFIRMED"); }
      if (settings.volumeConfirmation && !volumeConfirmed(input.candles, index)) { accepted = false; reasons.push("VOLUME_NOT_CONFIRMED"); }
      if (settings.cvdConfirmation) {
        const current = input.cvdValues?.[index];
        const prior = input.cvdValues?.[Math.max(0, index - settings.minimumExcursionBars)];
        if (!Number.isFinite(current) || !Number.isFinite(prior) || (direction === "long" ? current! <= prior! : current! >= prior!)) { accepted = false; reasons.push("CVD_UNAVAILABLE"); }
      }
      if (settings.higherTimeframeConfirmation) {
        const higherDirection = higherTimeframeDirections?.[index] ?? 0;
        if (higherDirection !== (direction === "long" ? 1 : -1)) { accepted = false; reasons.push("HIGHER_TIMEFRAME_CONFLICT"); }
      }
      if (confidence < settings.minimumConfirmationScore) { accepted = false; reasons.push("CONFIDENCE_BELOW_MINIMUM"); }

      if (accepted) runtime.state = "CONFIRMED";
      else if (runtime.state !== "COOLDOWN") runtime.state = confidence >= Math.max(0, settings.minimumConfirmationScore - 15) ? "ARMED" : "WATCHING";
      if (statePriority[runtime.state] > statePriority[barState]) barState = runtime.state;
      const episodeId = canonicalSignalId(input, rawSignal, settings.signalIntelligenceMode).replace("bc-rda-intel-v1", "bc-rda-episode-v1");
      if (!runtime.episode) {
        runtime.episode = { id: episodeId, direction, startIndex: index, confirmedIndex: null, resetIndex: null, peakConfidence: confidence, rawSignalCount: 1 };
        episodes.push(runtime.episode);
        if (episodes.length > DDA_PRO_MAX_SIGNAL_EPISODES) episodes.shift();
      } else {
        runtime.episode.rawSignalCount += 1;
        runtime.episode.peakConfidence = Math.max(runtime.episode.peakConfidence, confidence);
      }

      if (accepted) {
        const signal: DDAProSignalEvent = {
          ...rawSignal,
          id: canonicalSignalId(input, rawSignal, settings.signalIntelligenceMode),
          classification: "confirmed",
          confidence,
          regime: frame.regime,
          episodeId: runtime.episode.id,
          reasonCodes: [...new Set([...reasons, "SIGNAL_CONFIRMED" as const])]
        };
        confirmed.push(signal);
        runtime.episode.confirmedIndex = index;
        runtime.lastConfirmedIndex = index;
        runtime.lastConfirmedCentroid = frame.centroid;
        runtime.resetObserved = false;
        runtime.state = "COOLDOWN";
        confirmedDirections.add(direction);
        barState = "CONFIRMED";
      } else {
        suppressed += 1;
        if (confidence >= Math.max(0, settings.minimumConfirmationScore - 15)) {
          provisional.push({
            ...rawSignal,
            id: canonicalSignalId(input, rawSignal, settings.signalIntelligenceMode).replace("intel-v1", "provisional-v1"),
            classification: "provisional",
            confidence,
            regime: frame.regime,
            episodeId: runtime.episode.id,
            reasonCodes: [...new Set(reasons)]
          });
          if (provisional.length > DDA_PRO_MAX_PROVISIONAL_SIGNALS) provisional.shift();
        }
      }
    }
    longState[index] = confirmedDirections.has("long") ? "CONFIRMED" : runtimes.long.state;
    shortState[index] = confirmedDirections.has("short") ? "CONFIRMED" : runtimes.short.state;
    if ((rawByIndex.get(index) ?? []).length === 0) {
      if (statePriority[runtimes.long.state] > statePriority[barState]) barState = runtimes.long.state;
      if (statePriority[runtimes.short.state] > statePriority[barState]) barState = runtimes.short.state;
    }
    state[index] = barState;
  }

  const latestReasons = frames.length ? reasonsForFrame(frames.at(-1)!, settings) : [];

  return {
    signals: confirmed,
    rawSignals: raw,
    intelligence: {
      engineVersion: DDA_PRO_SIGNAL_INTELLIGENCE_VERSION,
      mode: settings.signalIntelligenceMode,
      regime: frames.map((frame) => frame.regime),
      regimeConfidence: frames.map((frame) => frame.regimeConfidence),
      longConfidence: frames.map((frame) => frame.longConfidence),
      shortConfidence: frames.map((frame) => frame.shortConfidence),
      chopProbability: frames.map((frame) => frame.chop),
      transitionEntropy: frames.map((frame) => frame.entropy),
      coherence: frames.map((frame) => frame.coherence),
      centroidVelocity: frames.map((frame) => frame.centroidVelocity),
      centroidAcceleration: frames.map((frame) => frame.centroidAcceleration),
      expansionScore: frames.map((frame) => frame.expansion),
      tailAsymmetry: frames.map((frame) => frame.signedTail),
      state,
      longState,
      shortState,
      rawCandidateSignals: raw,
      episodes,
      provisionalSignals: provisional,
      suppressedRawSignalCount: suppressed,
      latestReasonCodes: latestReasons.slice(0, 8)
    }
  };
}
