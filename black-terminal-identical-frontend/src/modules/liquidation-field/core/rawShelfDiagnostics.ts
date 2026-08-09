import type { LiquidationFieldSnapshot } from "./types.ts";

export interface BclifHighIntensityCellAudit {
  column: number;
  row: number;
  timestamp: number;
  price: number;
  rawCombinedExposure: number;
  globalNormalizedIntensity: number;
  columnPercentile: number;
  confidence: number;
  validity: boolean;
  cohortIds: string[];
  cohortCount: number;
  ageHours: number[];
  leverageContributions: Array<{ leverage: number; probability: number }>;
  entrySources: string[];
  marginModes: string[];
}

export function auditBclifHighIntensityCells(snapshot: LiquidationFieldSnapshot, limit = 20): BclifHighIntensityCellAudit[] {
  const { rows, columns, minPrice, priceStep } = snapshot.header;
  const candidates: Array<{ index: number; raw: number }> = [];
  const columnValues: number[][] = Array.from({ length: columns }, () => []);
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const index = column * rows + row;
      if (!snapshot.validity[index]) continue;
      const raw = snapshot.longExposure[index]! + snapshot.shortExposure[index]!;
      if (!(raw > 0)) continue;
      candidates.push({ index, raw });
      columnValues[column]!.push(raw);
    }
    columnValues[column]!.sort((left, right) => left - right);
  }
  candidates.sort((left, right) => right.raw - left.raw || left.index - right.index);
  return candidates.slice(0, Math.max(0, Math.min(100, Math.floor(limit)))).map(({ index, raw }) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const timestamp = snapshot.timestamps[column]!;
    const price = minPrice + row * priceStep;
    const pricePadding = Math.max(priceStep * 1.5, price * 0.00005);
    const cohorts = snapshot.cohorts.filter((cohort) => cohort.createdAt <= timestamp
      && cohort.estimatedRemainingNotional > 0
      && cohort.liquidationLower - pricePadding <= price
      && cohort.liquidationUpper + pricePadding >= price);
    const totalCohortMass = cohorts.reduce((sum, cohort) => sum + cohort.estimatedRemainingNotional, 0) || 1;
    const leverage = new Map<number, number>();
    for (const cohort of cohorts) {
      const cohortShare = cohort.estimatedRemainingNotional / totalCohortMass;
      for (const bucket of cohort.leverageDistribution) {
        leverage.set(bucket.leverage, (leverage.get(bucket.leverage) ?? 0) + cohortShare * bucket.probability);
      }
    }
    const values = columnValues[column]!;
    const below = upperBound(values, raw);
    return {
      column,
      row,
      timestamp,
      price,
      rawCombinedExposure: raw,
      globalNormalizedIntensity: snapshot.normalizedIntensity[index]! / 255,
      columnPercentile: values.length ? below / values.length : 0,
      confidence: snapshot.confidence[index]! / 255,
      validity: Boolean(snapshot.validity[index]),
      cohortIds: cohorts.map((cohort) => cohort.id).sort(),
      cohortCount: cohorts.length,
      ageHours: cohorts.map((cohort) => Math.max(0, timestamp - cohort.createdAt) / 3_600_000),
      leverageContributions: [...leverage].sort((left, right) => left[0] - right[0])
        .map(([leverageValue, probability]) => ({ leverage: leverageValue, probability })),
      entrySources: [...new Set(cohorts.map((cohort) => cohort.entryDistribution.source))].sort(),
      marginModes: [...new Set(cohorts.map((cohort) => cohort.marginMode))].sort()
    };
  });
}

export function buildBclifRawExposureExport(snapshot: LiquidationFieldSnapshot) {
  return {
    contract: "BCLIF_ABSOLUTE_RAW_EXPOSURE_V1",
    generatedAt: snapshot.generatedAt,
    authority: snapshot.authority,
    header: { ...snapshot.header },
    absoluteDistribution: snapshot.absoluteDistribution ?? {
      priceUnit: "QUOTE_PRICE",
      gridOrigin: snapshot.header.gridOrigin ?? 0,
      priceStep: snapshot.header.priceStep,
      minPrice: snapshot.header.minPrice,
      maxPrice: snapshot.header.maxPrice,
      rows: snapshot.header.rows,
      modelVersion: snapshot.header.modelVersion,
      gridVersion: snapshot.header.gridVersion ?? "UNVERSIONED"
    },
    timestamps: Array.from(snapshot.timestamps),
    longExposure: Array.from(snapshot.longExposure),
    shortExposure: Array.from(snapshot.shortExposure),
    validity: Array.from(snapshot.validity),
    rawCohortShelves: snapshot.rawCohortShelves ?? [],
    highIntensityCellAudit: auditBclifHighIntensityCells(snapshot, 20)
  };
}

function upperBound(sorted: readonly number[], value: number) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}
