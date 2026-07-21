import type { Candle } from "../../../chart-engine/types";
import { createStrategySignals } from "../adapters/signalAdapter";
import type { BacktestConfig } from "../types/backtest.types";
import type { OptimizationResult, OptimizationSpace } from "../types/optimization.types";
import { runBacktest } from "./backtestEngine";

function valuesForRange(min: number, max: number, step: number) {
  const values: number[] = [];
  const safeStep = Math.max(step, 0.0001);
  for (let value = min; value <= max + safeStep / 2; value += safeStep) {
    values.push(Number(value.toFixed(6)));
  }
  return values;
}

function parameterCombinations(space: OptimizationSpace, maxRuns: number) {
  const entries = Object.entries(space);
  const combinations: Record<string, number>[] = [{}];

  for (const [key, range] of entries) {
    const values = valuesForRange(range.min, range.max, range.step);
    const next: Record<string, number>[] = [];
    for (const combination of combinations) {
      for (const value of values) {
        next.push({ ...combination, [key]: value });
        if (next.length >= maxRuns) return next;
      }
    }
    combinations.splice(0, combinations.length, ...next);
  }

  return combinations.slice(0, maxRuns);
}

function parameterDistance(a: Record<string, number>, b: Record<string, number>) {
  const keys = Object.keys(a);
  return keys.reduce((sum, key) => sum + Math.abs((a[key] ?? 0) - (b[key] ?? 0)), 0);
}

function normalize(value: number, min: number, max: number) {
  if (max - min <= 0) return 0;
  return (value - min) / (max - min);
}

function assignRobustness(results: OptimizationResult[]) {
  const profits = results.map((result) => result.backtest.metrics.netProfit);
  const drawdowns = results.map((result) => result.backtest.metrics.maxDrawdown);
  const profitMin = Math.min(...profits);
  const profitMax = Math.max(...profits);
  const drawdownMin = Math.min(...drawdowns);
  const drawdownMax = Math.max(...drawdowns);

  for (const result of results) {
    const neighbors = [...results]
      .filter((candidate) => candidate.id !== result.id)
      .sort((a, b) => parameterDistance(a.parameters, result.parameters) - parameterDistance(b.parameters, result.parameters))
      .slice(0, 6);
    const neighborProfit = neighbors.length
      ? neighbors.reduce((sum, item) => sum + item.backtest.metrics.netProfit, 0) / neighbors.length
      : result.backtest.metrics.netProfit;
    const ownProfitScore = normalize(result.backtest.metrics.netProfit, profitMin, profitMax);
    const neighborScore = normalize(neighborProfit, profitMin, profitMax);
    const drawdownScore = 1 - normalize(result.backtest.metrics.maxDrawdown, drawdownMin, drawdownMax);
    result.robustnessScore = Math.max(0, Math.min(100, (ownProfitScore * 0.34 + neighborScore * 0.46 + drawdownScore * 0.2) * 100));
    result.overfitWarning = ownProfitScore > 0.82 && neighborScore < 0.45;
  }
}

export function runOptimization(
  candles: Candle[],
  baseConfig: BacktestConfig,
  space: OptimizationSpace,
  maxRuns = 64
) {
  const combinations = parameterCombinations(space, maxRuns);
  const results: OptimizationResult[] = combinations.map((parameters, index) => {
    const config: BacktestConfig = {
      ...baseConfig,
      strategySettings: {
        ...baseConfig.strategySettings,
        ...parameters
      }
    };
    const signals = createStrategySignals(config.strategyKind, candles, config.symbol, config.strategySettings);
    return {
      id: `OPT-${index + 1}`,
      parameters,
      backtest: runBacktest(candles, signals, config),
      robustnessScore: 0,
      overfitWarning: false
    };
  });

  assignRobustness(results);
  return results.sort((a, b) => b.robustnessScore - a.robustnessScore);
}
