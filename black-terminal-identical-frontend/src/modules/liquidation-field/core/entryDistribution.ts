import type { CohortEntryDistribution, CohortEntrySource } from "./types.ts";

export interface BclifEntryObservation {
  price: number;
  weight: number;
}

export function buildCohortEntryDistribution(input: {
  observations: readonly BclifEntryObservation[];
  source: CohortEntrySource;
  intervalStart: number;
  intervalEnd: number;
  confidence: number;
  fallbackPrice: number;
  maximumRows?: number;
}): CohortEntryDistribution {
  if (!(input.intervalEnd > input.intervalStart)) throw new Error("BCLIF entry interval must advance");
  const maximumRows = Math.max(1, Math.min(16, Math.round(input.maximumRows ?? 7)));
  const usable = input.observations
    .filter((observation) => Number.isFinite(observation.price) && observation.price > 0 && Number.isFinite(observation.weight) && observation.weight > 0)
    .sort((left, right) => left.price - right.price);
  const observations = usable.length ? usable : [{ price: input.fallbackPrice, weight: 1 }];
  if (!Number.isFinite(input.fallbackPrice) || input.fallbackPrice <= 0) throw new Error("BCLIF entry fallback price is invalid");
  const rows = compressWeightedRows(observations, maximumRows);
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0)) throw new Error("BCLIF entry distribution has no probability mass");
  const priceRows = rows.map((row) => row.price);
  const weights = rows.map((row) => row.weight / total);
  // Repair the final floating-point residue so the serialized distribution has
  // an exactly conserved unit mass within machine precision.
  weights[weights.length - 1] = 1 - weights.slice(0, -1).reduce((sum, weight) => sum + weight, 0);
  const confidence = clamp01(input.confidence);
  const hash = entryDistributionHash({
    priceRows,
    weights,
    source: input.source,
    intervalStart: input.intervalStart,
    intervalEnd: input.intervalEnd,
    confidence,
    hash: ""
  });
  return { priceRows, weights, source: input.source, intervalStart: input.intervalStart, intervalEnd: input.intervalEnd, confidence, hash };
}

export function entryDistributionHash(distribution: Omit<CohortEntryDistribution, "hash"> | CohortEntryDistribution) {
  const text = [
    distribution.source,
    distribution.intervalStart,
    distribution.intervalEnd,
    distribution.confidence.toFixed(8),
    ...distribution.priceRows.flatMap((price, index) => [price.toFixed(8), distribution.weights[index]!.toFixed(12)])
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

export function entryDistributionMoments(distribution: CohortEntryDistribution) {
  validateEntryDistribution(distribution);
  const mean = distribution.priceRows.reduce((sum, price, index) => sum + price * distribution.weights[index]!, 0);
  const variance = distribution.priceRows.reduce((sum, price, index) => sum + (price - mean) ** 2 * distribution.weights[index]!, 0);
  return { mean, standardDeviation: Math.sqrt(Math.max(0, variance)) };
}

export function validateEntryDistribution(distribution: CohortEntryDistribution) {
  if (!(distribution.intervalEnd > distribution.intervalStart)) throw new Error("BCLIF entry distribution interval is invalid");
  if (!distribution.priceRows.length || distribution.priceRows.length !== distribution.weights.length || distribution.priceRows.length > 16) {
    throw new Error("BCLIF entry distribution dimensions are invalid");
  }
  if (distribution.priceRows.some((price) => !Number.isFinite(price) || price <= 0)) throw new Error("BCLIF entry distribution price is invalid");
  if (distribution.weights.some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error("BCLIF entry distribution weight is invalid");
  const total = distribution.weights.reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error("BCLIF entry distribution does not conserve unit mass");
  if (entryDistributionHash(distribution) !== distribution.hash) throw new Error("BCLIF entry distribution hash mismatch");
}

function compressWeightedRows(observations: readonly BclifEntryObservation[], maximumRows: number) {
  if (observations.length <= maximumRows) return observations.map((observation) => ({ ...observation }));
  const total = observations.reduce((sum, observation) => sum + observation.weight, 0);
  const target = total / maximumRows;
  const rows: BclifEntryObservation[] = [];
  let bucketWeight = 0;
  let bucketPriceWeight = 0;
  for (const observation of observations) {
    let remaining = observation.weight;
    while (remaining > 0 && rows.length < maximumRows - 1) {
      const accepted = Math.min(remaining, target - bucketWeight);
      bucketWeight += accepted;
      bucketPriceWeight += observation.price * accepted;
      remaining -= accepted;
      if (bucketWeight >= target - 1e-12) {
        rows.push({ price: bucketPriceWeight / bucketWeight, weight: bucketWeight });
        bucketWeight = 0;
        bucketPriceWeight = 0;
      }
    }
    if (remaining > 0) {
      bucketWeight += remaining;
      bucketPriceWeight += observation.price * remaining;
    }
  }
  if (bucketWeight > 0) rows.push({ price: bucketPriceWeight / bucketWeight, weight: bucketWeight });
  return rows;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
