import type { DDAProQuantileMethod, DDAProSmoothingMethod } from "./types.ts";

export const finiteOrZero = (value: number) => Number.isFinite(value) ? value : 0;

export function mean(values: readonly number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function populationDeviation(values: readonly number[], center = mean(values)) {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

export function sampleDeviation(values: readonly number[], center = mean(values)) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

export function quantile(sortedValues: readonly number[], probability: number, method: DDAProQuantileMethod) {
  if (!sortedValues.length) return 0;
  const p = Math.max(0, Math.min(1, probability));
  if (method === "nearest-rank") {
    const rank = Math.max(1, Math.ceil(p * sortedValues.length));
    return sortedValues[Math.min(sortedValues.length - 1, rank - 1)] ?? 0;
  }
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const h = (sortedValues.length - 1) * p;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  const weight = h - lower;
  return (sortedValues[lower] ?? 0) * (1 - weight) + (sortedValues[upper] ?? 0) * weight;
}

export function percentileRank(sortedValues: readonly number[], value: number) {
  if (!sortedValues.length) return 0;
  let upper = 0;
  while (upper < sortedValues.length && (sortedValues[upper] ?? 0) <= value) upper += 1;
  return upper / sortedValues.length * 100;
}

export function median(values: readonly number[]) {
  if (!values.length) return 0;
  return quantile([...values].sort((left, right) => left - right), 0.5, "type7");
}

function medianAbsoluteDeviationSorted(sortedValues: readonly number[], center: number) {
  if (!sortedValues.length) return 0;
  let left = (sortedValues.length - 1) >>> 1;
  let right = left + 1;
  const lowerRank = Math.floor((sortedValues.length - 1) / 2);
  const upperRank = Math.floor(sortedValues.length / 2);
  let lowerValue = 0;
  let upperValue = 0;
  for (let rank = 0; rank <= upperRank; rank++) {
    const leftDistance = left >= 0 ? Math.abs((sortedValues[left] ?? center) - center) : Number.POSITIVE_INFINITY;
    const rightDistance = right < sortedValues.length ? Math.abs((sortedValues[right] ?? center) - center) : Number.POSITIVE_INFINITY;
    const next = leftDistance <= rightDistance ? (left -= 1, leftDistance) : (right += 1, rightDistance);
    if (rank === lowerRank) lowerValue = next;
    if (rank === upperRank) upperValue = next;
  }
  return (lowerValue + upperValue) / 2;
}

export function mad(values: readonly number[], center = median(values)) {
  return median(values.map((value) => Math.abs(value - center)));
}

export function smoothSeries(values: readonly number[], method: DDAProSmoothingMethod, length: number) {
  if (method === "none" || length <= 1) return [...values];
  const period = Math.max(1, Math.round(length));
  const output = new Array<number>(values.length).fill(0);
  if (method === "sma") {
    let sum = 0;
    for (let index = 0; index < values.length; index++) {
      sum += values[index] ?? 0;
      if (index >= period) sum -= values[index - period] ?? 0;
      output[index] = sum / Math.min(period, index + 1);
    }
    return output;
  }
  const alpha = method === "rma" ? 1 / period : 2 / (period + 1);
  output[0] = values[0] ?? 0;
  for (let index = 1; index < values.length; index++) {
    output[index] = alpha * (values[index] ?? 0) + (1 - alpha) * (output[index - 1] ?? 0);
  }
  return output;
}

export function insertSorted(values: number[], value: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? 0) <= value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

export function removeSorted(values: number[], value: number) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = values[middle] ?? 0;
    if (candidate < value) low = middle + 1;
    else if (candidate > value) high = middle - 1;
    else {
      values.splice(middle, 1);
      return;
    }
  }
}

export function rollingMaximum(values: readonly number[], lookback: number) {
  const result = new Array<number>(values.length).fill(0);
  const deque: number[] = [];
  for (let index = 0; index < values.length; index++) {
    while (deque.length && deque[0]! <= index - lookback) deque.shift();
    while (deque.length && (values[deque.at(-1)!] ?? 0) <= (values[index] ?? 0)) deque.pop();
    deque.push(index);
    result[index] = values[deque[0]!] ?? 0;
  }
  return result;
}

export function rollingMinimum(values: readonly number[], lookback: number) {
  const result = new Array<number>(values.length).fill(0);
  const deque: number[] = [];
  for (let index = 0; index < values.length; index++) {
    while (deque.length && deque[0]! <= index - lookback) deque.shift();
    while (deque.length && (values[deque.at(-1)!] ?? 0) >= (values[index] ?? 0)) deque.pop();
    deque.push(index);
    result[index] = values[deque[0]!] ?? 0;
  }
  return result;
}

export type RollingDistributionPoint = {
  mean: number;
  deviation: number;
  rank: number;
  quantiles: readonly [number, number, number, number, number, number, number, number];
};

export function rollingDistribution(
  values: readonly number[],
  lookback: number,
  method: DDAProQuantileMethod,
  robust = false
) {
  const output: RollingDistributionPoint[] = [];
  const sorted: number[] = [];
  let sum = 0;
  let sumSquares = 0;
  const probabilities = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99] as const;
  for (let index = 0; index < values.length; index++) {
    const value = finiteOrZero(values[index] ?? 0);
    insertSorted(sorted, value);
    sum += value;
    sumSquares += value * value;
    if (index >= lookback) {
      const removed = finiteOrZero(values[index - lookback] ?? 0);
      removeSorted(sorted, removed);
      sum -= removed;
      sumSquares -= removed * removed;
    }
    const count = sorted.length;
    const center = robust ? quantile(sorted, 0.5, method) : sum / Math.max(1, count);
    const deviation = robust
      ? Math.max(0, medianAbsoluteDeviationSorted(sorted, center) * 1.4826)
      : Math.sqrt(Math.max(0, sumSquares / Math.max(1, count) - center * center));
    output.push({
      mean: center,
      deviation,
      rank: percentileRank(sorted, value),
      quantiles: [
        quantile(sorted, probabilities[0], method), quantile(sorted, probabilities[1], method),
        quantile(sorted, probabilities[2], method), quantile(sorted, probabilities[3], method),
        quantile(sorted, probabilities[4], method), quantile(sorted, probabilities[5], method),
        quantile(sorted, probabilities[6], method), quantile(sorted, probabilities[7], method)
      ]
    });
  }
  return output;
}
