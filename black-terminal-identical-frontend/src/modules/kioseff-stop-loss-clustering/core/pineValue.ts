export type PineValue<T> = T | undefined;

export const PINE_NA = undefined;

export function pineNa(value: unknown): value is undefined {
  return value === undefined;
}

export function pineFinite(value: unknown): PineValue<number> {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pineNz(value: PineValue<number>, replacement = 0) {
  return value === undefined ? replacement : value;
}

export function pineSign(value: PineValue<number>): PineValue<-1 | 0 | 1> {
  if (value === undefined) return undefined;
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export function pineChange(
  current: PineValue<number>,
  previous: PineValue<number>
): PineValue<number> {
  if (current === undefined || previous === undefined) return undefined;
  return current - previous;
}

export function pineOverlap(
  lowA: PineValue<number>,
  highA: PineValue<number>,
  lowB: PineValue<number>,
  highB: PineValue<number>
) {
  if (lowA === undefined || highA === undefined || lowB === undefined || highB === undefined) {
    return false;
  }
  return Math.max(lowA, lowB) <= Math.min(highA, highB);
}

export function pineEqual(left: PineValue<number>, right: PineValue<number>) {
  return left !== undefined && right !== undefined && left === right;
}

