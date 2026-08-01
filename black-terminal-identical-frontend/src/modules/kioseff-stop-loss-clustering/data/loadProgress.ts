import type { KioseffLoadState } from "./loadState.ts";

function boundedPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function partialWarmupProgress(
  completedBars: number,
  targetBars: number | undefined,
  stageOffset: number
) {
  if (!targetBars || completedBars >= targetBars) return null;
  return boundedPercent(17 + (completedBars / targetBars) * 58 + stageOffset);
}

export function kioseffLoadProgress(state: KioseffLoadState) {
  switch (state.stage) {
    case "idle":
      return 0;
    case "requesting-symbol-metadata":
      return 3;
    case "fetching-chart-history":
      return boundedPercent(
        3 + (state.target > 0 ? state.loaded / state.target : 0) * 14
      );
    case "fetching-intrabar-history":
      return boundedPercent(
        17 +
          (state.target && state.target > 0 ? state.loaded / state.target : 0) * 58
      );
    case "grouping-intrabars":
      return partialWarmupProgress(state.bars, state.targetBars, 0) ?? 79;
    case "validating":
      return partialWarmupProgress(state.bars, state.targetBars, 0.01) ?? 84;
    case "starting-worker":
      return partialWarmupProgress(
        state.bars ?? state.targetBars ?? 0,
        state.targetBars,
        0.015
      ) ?? 88;
    case "rebuilding":
      return partialWarmupProgress(state.bars, state.targetBars, 0.02) ?? 92;
    case "calculating":
      return partialWarmupProgress(state.bars, state.targetBars, 0.03) ?? 96;
    case "rendering":
      return partialWarmupProgress(
        state.completedBars ?? state.targetBars ?? 0,
        state.targetBars,
        0.04
      ) ?? 99;
    case "warming":
      return boundedPercent(
        17.05 +
          (state.targetBars > 0
            ? state.completedBars / state.targetBars
            : 0) *
            58
      );
    case "ready":
      return 100;
    case "degraded":
    case "unavailable":
    case "error":
      return 0;
  }
}
