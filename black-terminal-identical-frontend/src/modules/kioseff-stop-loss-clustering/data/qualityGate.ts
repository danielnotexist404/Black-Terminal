import type { KioseffChartBarInput } from "./types.ts";
import { KioseffDataUnavailableError } from "./types.ts";

export function isKioseffInputQualityCertified(input: KioseffChartBarInput) {
  return (
    input.quality.complete &&
    !input.quality.sourceMismatch &&
    input.quality.missingTimes.length === 0 &&
    input.quality.conflictingTimes.length === 0 &&
    input.quality.duplicateTimes.length === 0 &&
    input.quality.outOfOrderTimes.length === 0
  );
}

export function certifiedKioseffInputTail(
  inputs: readonly KioseffChartBarInput[]
) {
  let start = 0;
  for (let index = 0; index < inputs.length; index += 1) {
    if (!isKioseffInputQualityCertified(inputs[index]!)) start = index + 1;
  }
  return inputs.slice(start);
}

export function assertKioseffInputQuality(inputs: readonly KioseffChartBarInput[]) {
  if (!inputs.length) {
    throw new KioseffDataUnavailableError("missing-intrabar-history", { chartBars: 0 });
  }
  for (const input of inputs) {
    if (input.quality.sourceMismatch) {
      throw new KioseffDataUnavailableError("source-history-live-mismatch", {
        chartBarTime: input.chartBar.time
      });
    }
    if (!isKioseffInputQualityCertified(input)) {
      throw new KioseffDataUnavailableError("incomplete-intrabar-coverage", {
        chartBarTime: input.chartBar.time,
        expected: input.quality.expectedCount,
        actual: input.quality.actualCount,
        missingTimes: input.quality.missingTimes,
        duplicateTimes: input.quality.duplicateTimes,
        outOfOrderTimes: input.quality.outOfOrderTimes,
        conflictingTimes: input.quality.conflictingTimes
      });
    }
  }
}
