import type { KioseffChartBarInput } from "./types.ts";
import { KioseffDataUnavailableError } from "./types.ts";

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
    if (
      !input.quality.complete ||
      input.quality.missingTimes.length ||
      input.quality.conflictingTimes.length ||
      input.quality.duplicateTimes.length ||
      input.quality.outOfOrderTimes.length
    ) {
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
