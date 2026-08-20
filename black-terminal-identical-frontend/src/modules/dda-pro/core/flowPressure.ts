import type {
  DDAProCalculationInput,
  DDAProFlowAuthority,
  DDAProFlowState,
  DDAProSeries
} from "./types.ts";

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

function median(sorted: readonly number[]) {
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle] ?? 0
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function robustBoundedScore(history: readonly number[], value: number) {
  const finite = history.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (finite.length < 10) return clamp(value, -1, 1);
  const center = median(finite);
  const deviations = finite.map((candidate) => Math.abs(candidate - center)).sort((left, right) => left - right);
  const robustDeviation = median(deviations) * 1.4826;
  if (!(robustDeviation > 1e-9)) return clamp(value, -1, 1);
  return Math.tanh(((value - center) / robustDeviation) / 2);
}

export type DDAProFlowCalculationResult = {
  authority: DDAProFlowAuthority;
  warning: string | null;
};

export function calculateDDAProFlowPressure(
  input: DDAProCalculationInput,
  series: DDAProSeries
): DDAProFlowCalculationResult {
  const bars = input.flowBars;
  const length = input.candles.length;
  if (input.flowAuthority !== "EXACT_AGGRESSOR_TRADES" || !bars || bars.length !== length) {
    return {
      authority: "UNAVAILABLE",
      warning: input.flowWarning ?? "Genuine aggressor-trade data is unavailable for the selected BC-RDA range."
    };
  }

  const settings = input.settings;
  const smoothingLength = Math.max(1, settings.flowPressureSmoothingLength);
  const normalizationLookback = Math.max(20, settings.flowPressureNormalizationLookback);
  const weightTotal = settings.flowAggressorWeight + settings.flowCvdWeight;
  const imbalanceHistory: number[] = [];
  const cvdHistory: number[] = [];
  let smoothedPressure: number | null = null;
  let availableCount = 0;

  for (let index = 0; index < length; index++) {
    const bar = bars[index]!;
    const exactNotional = bar.buyNotional + bar.sellNotional;
    const totalNotional = exactNotional + bar.unknownNotional;
    const coverage = totalNotional > 0 ? exactNotional / totalNotional * 100 : 0;
    series.flowCoveragePercent[index] = coverage;

    if (!bar.deliveryComplete || !(exactNotional > 0) || coverage < settings.flowPressureMinimumCoveragePercent || !(weightTotal > 0)) {
      smoothedPressure = null;
      continue;
    }

    const imbalance = (bar.buyNotional - bar.sellNotional) / exactNotional;
    let cumulativeDelta = 0;
    let cumulativeVolume = 0;
    for (let cursor = Math.max(0, index - smoothingLength + 1); cursor <= index; cursor++) {
      const candidate = bars[cursor]!;
      const candidateExactNotional = candidate.buyNotional + candidate.sellNotional;
      const candidateTotalNotional = candidateExactNotional + candidate.unknownNotional;
      const candidateCoverage = candidateTotalNotional > 0 ? candidateExactNotional / candidateTotalNotional * 100 : 100;
      if (!candidate.deliveryComplete || candidateCoverage < settings.flowPressureMinimumCoveragePercent) {
        cumulativeDelta = 0;
        cumulativeVolume = 0;
        continue;
      }
      cumulativeDelta += candidate.buyVolume - candidate.sellVolume;
      cumulativeVolume += candidate.buyVolume + candidate.sellVolume;
    }
    if (!(cumulativeVolume > 0)) {
      smoothedPressure = null;
      continue;
    }

    const cvdMomentum = cumulativeDelta / cumulativeVolume;
    series.flowImbalance[index] = imbalance;
    series.flowCvdMomentum[index] = cvdMomentum;
    imbalanceHistory.push(imbalance);
    cvdHistory.push(cvdMomentum);
    if (imbalanceHistory.length > normalizationLookback) imbalanceHistory.shift();
    if (cvdHistory.length > normalizationLookback) cvdHistory.shift();

    const normalizedImbalance = robustBoundedScore(imbalanceHistory, imbalance);
    const normalizedCvd = robustBoundedScore(cvdHistory, cvdMomentum);
    const rawPressure = 100 * (
      normalizedImbalance * settings.flowAggressorWeight +
      normalizedCvd * settings.flowCvdWeight
    ) / weightTotal;
    const alpha = 2 / (smoothingLength + 1);
    smoothedPressure = smoothedPressure === null ? rawPressure : alpha * rawPressure + (1 - alpha) * smoothedPressure;
    const pressure = clamp(smoothedPressure, -100, 100);
    const state: DDAProFlowState = pressure > settings.flowPressureNeutralThreshold
      ? "BULLISH"
      : pressure < -settings.flowPressureNeutralThreshold
        ? "BEARISH"
        : "NEUTRAL";
    series.flowPressure[index] = pressure;
    series.flowState[index] = state;
    availableCount += 1;
  }

  return {
    authority: availableCount ? "EXACT_AGGRESSOR_TRADES" : "UNAVAILABLE",
    warning: availableCount
      ? input.flowWarning ?? null
      : input.flowWarning ?? "BC-RDA Flow Pressure has not received enough continuous classified trade evidence yet."
  };
}
