import type { Candle } from "../../../chart-engine/types";
import { createStrategySignals } from "../adapters/signalAdapter";
import type { BacktestConfig } from "../types/backtest.types";
import type { OptimizationSpace, WalkForwardWindow } from "../types/optimization.types";
import { runBacktest } from "./backtestEngine";
import { runOptimization } from "./optimizer";

export function runWalkForward(
  candles: Candle[],
  baseConfig: BacktestConfig,
  space: OptimizationSpace,
  trainBars = 360,
  validateBars = 120,
  maxOptimizationRuns = 32
): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  let start = 0;
  let id = 1;

  while (start + trainBars + validateBars <= candles.length) {
    const train = candles.slice(start, start + trainBars);
    const validate = candles.slice(start + trainBars, start + trainBars + validateBars);
    const optimization = runOptimization(train, baseConfig, space, maxOptimizationRuns);
    const best = optimization[0];
    if (!best) break;

    const validationConfig: BacktestConfig = {
      ...baseConfig,
      strategySettings: {
        ...baseConfig.strategySettings,
        ...best.parameters
      }
    };
    const validateSignals = createStrategySignals(validationConfig.strategyKind, validate, validationConfig.symbol, validationConfig.strategySettings);
    const outOfSample = runBacktest(validate, validateSignals, validationConfig);
    const inSampleReturn = best.backtest.metrics.returnOnCapital;
    const outReturn = outOfSample.metrics.returnOnCapital;
    const stability = inSampleReturn === 0 ? 0 : Math.max(0, Math.min(1, outReturn / Math.abs(inSampleReturn)));

    windows.push({
      id: `WF-${id++}`,
      trainStart: train[0]?.time ?? 0,
      trainEnd: train[train.length - 1]?.time ?? 0,
      validateStart: validate[0]?.time ?? 0,
      validateEnd: validate[validate.length - 1]?.time ?? 0,
      bestParameters: best.parameters,
      inSample: best.backtest,
      outOfSample,
      stability,
      overfittingRisk: stability > 0.68 ? "Low" : stability > 0.34 ? "Medium" : "High"
    });

    start += validateBars;
  }

  return windows;
}
