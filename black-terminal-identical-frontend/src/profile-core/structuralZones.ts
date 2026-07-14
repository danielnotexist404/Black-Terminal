export type StructuralZoneMethod = "hybrid-structural" | "percentile" | "neighbor-contrast" | "robust-z-score" | "valley-detection" | "relative-poc";

export type StructuralActivityRow = {
  index: number;
  low: number;
  high: number;
  center: number;
  activity: number;
};

export type StructuralZoneSettings = {
  method: StructuralZoneMethod;
  percentileThreshold: number;
  relativePocThreshold: number;
  robustZThreshold: number;
  neighborWindow: number;
  minimumNeighborContrast: number;
  minimumContiguousRows: number;
  maximumInternalGapRows: number;
  minimumWidthRows: number;
  maximumWidthRows: number;
  mergeDistanceRows: number;
  edgeExclusionRows: number;
  minimumScore: number;
};

export type StructuralLowActivityZone = {
  startIndex: number;
  endIndex: number;
  low: number;
  high: number;
  center: number;
  weightedCenter: number;
  minimumActivityPrice: number;
  widthAbsolute: number;
  widthPercent: number;
  widthRows: number;
  rawActivity: number;
  normalizedActivity: number;
  activityPercentile: number;
  neighborContrast: number;
  valleyDepth: number;
  structuralScore: number;
  method: StructuralZoneMethod;
  algorithmVersion: "hybrid-structural-v1";
};

export function extractStructuralLowActivityZones(rows: StructuralActivityRow[], settings: StructuralZoneSettings): StructuralLowActivityZone[] {
  if (rows.length < 3) return [];
  const activities = rows.map((row) => Math.max(0, Math.abs(row.activity)));
  const maximum = Math.max(...activities, 1e-12);
  const sorted = [...activities].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const mad = quantile(activities.map((value) => Math.abs(value - median)).sort((a, b) => a - b), 0.5) || 1e-12;
  const percentileCutoff = quantile(sorted, clamp(settings.percentileThreshold / 100, 0.01, 0.8));
  const candidates: boolean[] = rows.map((row, index) => {
    if (index < settings.edgeExclusionRows || index >= rows.length - settings.edgeExclusionRows) return false;
    const activity = activities[index];
    const neighbors = neighborValues(activities, index, settings.neighborWindow);
    const neighborAverage = average(neighbors) || 1e-12;
    const contrast = neighborAverage / Math.max(activity, maximum * 1e-9);
    const robustZ = 0.6745 * (activity - median) / mad;
    const valley = activity <= (activities[index - 1] ?? activity) && activity <= (activities[index + 1] ?? activity);
    if (settings.method === "relative-poc") return activity / maximum <= settings.relativePocThreshold;
    if (settings.method === "percentile") return activity <= percentileCutoff;
    if (settings.method === "neighbor-contrast") return contrast >= settings.minimumNeighborContrast;
    if (settings.method === "robust-z-score") return robustZ <= settings.robustZThreshold;
    if (settings.method === "valley-detection") return valley && contrast >= settings.minimumNeighborContrast;
    const percentileScore = activity <= percentileCutoff ? 1 : clamp((percentileCutoff * 1.35 - activity) / Math.max(percentileCutoff, 1e-12), 0, 1);
    const contrastScore = clamp((contrast - 1) / Math.max(0.25, settings.minimumNeighborContrast - 1), 0, 1);
    const zScore = clamp(Math.abs(Math.min(0, robustZ)) / Math.max(1, Math.abs(settings.robustZThreshold)), 0, 1);
    const valleyScore = valley ? 1 : 0;
    return percentileScore * 0.34 + contrastScore * 0.31 + zScore * 0.2 + valleyScore * 0.15 >= 0.58;
  });

  const groups = contiguousGroups(candidates, Math.max(0, Math.round(settings.maximumInternalGapRows)));
  const zones = groups
    .filter(([start, end]) => end - start + 1 >= settings.minimumContiguousRows)
    .map(([start, end]) => buildZone(rows, activities, sorted, maximum, start, end, settings))
    .filter((zone): zone is StructuralLowActivityZone => Boolean(zone))
    .filter((zone) => zone.widthRows >= settings.minimumWidthRows && zone.widthRows <= settings.maximumWidthRows && zone.neighborContrast >= settings.minimumNeighborContrast && zone.structuralScore >= settings.minimumScore);
  return mergeStructuralZones(zones, rows, Math.max(0, Math.round(settings.mergeDistanceRows)));
}

export function mergeStructuralZones(zones: StructuralLowActivityZone[], rows: StructuralActivityRow[], distanceRows: number) {
  const sorted = [...zones].sort((a, b) => a.startIndex - b.startIndex);
  const output: StructuralLowActivityZone[] = [];
  for (const zone of sorted) {
    const previous = output.at(-1);
    if (!previous || zone.startIndex - previous.endIndex - 1 > distanceRows) {
      output.push(zone);
      continue;
    }
    const mergedRows = rows.slice(previous.startIndex, zone.endIndex + 1);
    const rebuilt = buildZone(mergedRows, mergedRows.map((row) => Math.abs(row.activity)), mergedRows.map((row) => Math.abs(row.activity)).sort((a, b) => a - b), Math.max(...mergedRows.map((row) => Math.abs(row.activity)), 1e-12), 0, mergedRows.length - 1, {
      method: previous.method, percentileThreshold: 25, relativePocThreshold: 0.2, robustZThreshold: -1, neighborWindow: 1,
      minimumNeighborContrast: 0, minimumContiguousRows: 1, maximumInternalGapRows: 0, minimumWidthRows: 1,
      maximumWidthRows: Number.MAX_SAFE_INTEGER, mergeDistanceRows: distanceRows, edgeExclusionRows: 0, minimumScore: 0
    });
    if (rebuilt) output[output.length - 1] = { ...rebuilt, startIndex: previous.startIndex, endIndex: zone.endIndex, method: previous.method, structuralScore: Math.max(previous.structuralScore, zone.structuralScore), neighborContrast: Math.max(previous.neighborContrast, zone.neighborContrast) };
  }
  return output;
}

function buildZone(rows: StructuralActivityRow[], activities: number[], sorted: number[], maximum: number, start: number, end: number, settings: StructuralZoneSettings): StructuralLowActivityZone | null {
  const source = rows.slice(start, end + 1);
  if (!source.length) return null;
  const zoneActivities = activities.slice(start, end + 1);
  const rawActivity = zoneActivities.reduce((sum, value) => sum + value, 0);
  const minimumIndex = zoneActivities.indexOf(Math.min(...zoneActivities));
  const inverseWeights = zoneActivities.map((value) => 1 / Math.max(value, maximum * 1e-6));
  const weightTotal = inverseWeights.reduce((sum, value) => sum + value, 0);
  const weightedCenter = source.reduce((sum, row, index) => sum + row.center * inverseWeights[index], 0) / Math.max(weightTotal, 1e-12);
  const neighbors = [...activities.slice(Math.max(0, start - settings.neighborWindow), start), ...activities.slice(end + 1, end + 1 + settings.neighborWindow)];
  const neighborAverage = average(neighbors) || maximum;
  const zoneAverage = rawActivity / source.length;
  const neighborContrast = neighborAverage / Math.max(zoneAverage, maximum * 1e-9);
  const valleyDepth = clamp(1 - zoneAverage / Math.max(neighborAverage, 1e-12), 0, 1);
  const activityPercentile = percentileRank(sorted, zoneAverage) * 100;
  const widthRows = source.length;
  const widthScore = clamp(widthRows / Math.max(1, settings.minimumWidthRows * 2), 0, 1);
  const structuralScore = Math.round(clamp((1 - activityPercentile / 100) * 0.3 + clamp((neighborContrast - 1) / 4, 0, 1) * 0.32 + valleyDepth * 0.25 + widthScore * 0.13, 0, 1) * 100);
  const low = source[0].low;
  const high = source.at(-1)!.high;
  return {
    startIndex: source[0].index, endIndex: source.at(-1)!.index, low, high, center: (low + high) / 2,
    weightedCenter, minimumActivityPrice: source[minimumIndex].center, widthAbsolute: high - low,
    widthPercent: low > 0 ? (high - low) / low * 100 : 0, widthRows, rawActivity,
    normalizedActivity: zoneAverage / maximum, activityPercentile, neighborContrast, valleyDepth,
    structuralScore, method: settings.method, algorithmVersion: "hybrid-structural-v1"
  };
}

function contiguousGroups(candidates: boolean[], maximumGap: number) {
  const groups: Array<[number, number]> = [];
  let start = -1;
  let lastCandidate = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index]) {
      if (start < 0) start = index;
      lastCandidate = index;
      continue;
    }
    if (start >= 0 && index - lastCandidate - 1 > maximumGap) {
      groups.push([start, lastCandidate]); start = -1; lastCandidate = -1;
    }
  }
  if (start >= 0) groups.push([start, lastCandidate]);
  return groups;
}

function neighborValues(values: number[], index: number, window: number) {
  const output: number[] = [];
  for (let offset = 1; offset <= Math.max(1, window); offset += 1) {
    if (values[index - offset] != null) output.push(values[index - offset]);
    if (values[index + offset] != null) output.push(values[index + offset]);
  }
  return output;
}
function quantile(values: number[], q: number) { if (!values.length) return 0; const position = (values.length - 1) * q; const low = Math.floor(position); const high = Math.ceil(position); return values[low] + (values[high] - values[low]) * (position - low); }
function percentileRank(sorted: number[], value: number) { let index = 0; while (index < sorted.length && sorted[index] <= value) index += 1; return index / Math.max(1, sorted.length); }
function average(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
