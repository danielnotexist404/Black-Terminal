export function pineIndex(length: number, index: number) {
  const resolved = index < 0 ? length + index : index;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved >= length) {
    throw new RangeError(`Pine array index ${index} is out of bounds for size ${length}`);
  }
  return resolved;
}

export function pineGet<T>(values: readonly T[], index: number) {
  return values[pineIndex(values.length, index)]!;
}

export function pineSet<T>(values: T[], index: number, value: T) {
  values[pineIndex(values.length, index)] = value;
}

export function pineRemove<T>(values: T[], index: number) {
  return values.splice(pineIndex(values.length, index), 1)[0]!;
}

export function pineShift<T>(values: T[]) {
  if (!values.length) throw new RangeError("Cannot shift an empty Pine array");
  return values.shift()!;
}

export function pinePush<T>(values: T[], value: T) {
  values.push(value);
}

export function pineUnshift<T>(values: T[], value: T) {
  values.unshift(value);
}

export function pineInsert<T>(values: T[], index: number, value: T) {
  const resolved = index < 0 ? values.length + index : index;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > values.length) {
    throw new RangeError(`Pine insert index ${index} is out of bounds for size ${values.length}`);
  }
  values.splice(resolved, 0, value);
}

export function pineSlice<T>(values: readonly T[], from: number, to: number) {
  const start = from < 0 ? values.length + from : from;
  const end = to < 0 ? values.length + to : to;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > values.length
  ) {
    throw new RangeError(`Invalid Pine slice ${from}:${to} for size ${values.length}`);
  }
  return values.slice(start, end);
}

/**
 * Pine `array.binary_search_leftmost`: first equal item, otherwise the item immediately left
 * (smaller) than the insertion position. It may return -1 below the array range.
 */
export function pineBinarySearchLeftmost(values: readonly number[], target: number) {
  const firstGreaterOrEqual = lowerBound(values, target);
  if (firstGreaterOrEqual < values.length && values[firstGreaterOrEqual] === target) {
    return firstGreaterOrEqual;
  }
  return firstGreaterOrEqual - 1;
}

/**
 * Pine `array.binary_search_rightmost`: last equal item, otherwise the item immediately right
 * (larger) than the insertion position. It may return `size` above the array range.
 */
export function pineBinarySearchRightmost(values: readonly number[], target: number) {
  const firstGreater = upperBound(values, target);
  if (firstGreater > 0 && values[firstGreater - 1] === target) return firstGreater - 1;
  return firstGreater;
}

export function pineSortedInsertRightmost(values: number[], value: number) {
  const index = pineBinarySearchRightmost(values, value);
  pineInsert(values, index, value);
  return index;
}

export function lowerBound(values: readonly number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function upperBound(values: readonly number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

