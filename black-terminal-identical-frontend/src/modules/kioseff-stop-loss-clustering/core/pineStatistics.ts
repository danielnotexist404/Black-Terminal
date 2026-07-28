import type { PineValue } from "./pineValue.ts";

export function pineSma(values: readonly PineValue<number>[], length: number): PineValue<number> {
  if (!Number.isInteger(length) || length <= 0) throw new RangeError(`Invalid SMA length: ${length}`);
  const finite = values.filter((value): value is number => value !== undefined);
  if (finite.length < length) return undefined;
  const window = finite.slice(-length);
  return window.reduce((sum, value) => sum + value, 0) / length;
}

export function pinePercentileNearestRank(
  values: readonly PineValue<number>[],
  percentile: number
): PineValue<number> {
  const finite = values
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!finite.length) return undefined;
  const bounded = Math.max(0, Math.min(100, percentile));
  const rank = Math.max(1, Math.ceil((bounded / 100) * finite.length));
  return finite[Math.min(finite.length - 1, rank - 1)];
}

export function pineMedian(values: readonly PineValue<number>[]): PineValue<number> {
  const finite = values
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!finite.length) return undefined;
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2) return finite[middle];
  return (finite[middle - 1]! + finite[middle]!) / 2;
}

