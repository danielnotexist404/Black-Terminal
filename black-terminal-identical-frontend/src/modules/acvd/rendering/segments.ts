/**
 * Splits decimated chart indices into certified, contiguous render islands.
 *
 * Looking only at the sampled endpoints is insufficient: a low-detail render
 * may skip over an unavailable source bar and accidentally bridge the gap.
 * Every source index between two rendered samples is therefore validated.
 */
export function acvdContiguousFiniteSegments(
  renderedChartIndices: readonly number[],
  chartToSourceOffset: number,
  series: readonly (readonly number[])[]
): number[][] {
  if (series.length === 0) return [];

  const sourceLength = Math.min(...series.map((values) => values.length));
  const isFiniteSourceIndex = (sourceIndex: number) => sourceIndex >= 0
    && sourceIndex < sourceLength
    && series.every((values) => Number.isFinite(values[sourceIndex]));
  const isCertifiedRange = (firstSourceIndex: number, lastSourceIndex: number) => {
    for (let sourceIndex = firstSourceIndex; sourceIndex <= lastSourceIndex; sourceIndex++) {
      if (!isFiniteSourceIndex(sourceIndex)) return false;
    }
    return true;
  };

  const segments: number[][] = [];
  let segment: number[] = [];
  let previousSourceIndex: number | null = null;

  const flush = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (const chartIndex of renderedChartIndices) {
    const sourceIndex = chartIndex - chartToSourceOffset;
    if (!isFiniteSourceIndex(sourceIndex)) {
      flush();
      previousSourceIndex = null;
      continue;
    }

    if (
      previousSourceIndex !== null
      && !isCertifiedRange(previousSourceIndex + 1, sourceIndex)
    ) {
      flush();
    }

    segment.push(chartIndex);
    previousSourceIndex = sourceIndex;
  }

  flush();
  return segments;
}
