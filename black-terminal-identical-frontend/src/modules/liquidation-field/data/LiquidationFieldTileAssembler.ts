import type {
  BclifPersistentCoverage,
  LiquidationCoverage,
  LiquidationDataCertainty,
  LiquidationFieldSnapshot
} from "../core/types.ts";
import { BCLIF_MODEL_VERSION, BCLIF_SOURCE_VERSION } from "../core/types.ts";
import type { DecodedLiquidationFieldTile, PersistentTileManifestMetadata } from "./LiquidationFieldTileCodec.ts";
import { LiquidationFieldTileContractError } from "./LiquidationFieldTileCodec.ts";

const MAX_ASSEMBLED_COLUMNS = 8_192;
const MAX_ASSEMBLED_ROWS = 2_048;
const MAX_ASSEMBLED_CELLS = 8_388_608;

export interface PersistentLiquidationFieldCoverageInput {
  venue: string;
  symbol: string;
  horizon: string;
  requestedStart: number;
  requestedEnd: number;
  modelStart: number | null;
  modelEnd: number | null;
  coverage: {
    trades: number | null;
    openInterest: number | null;
    liquidations: number | null;
    orderbook: number | null;
    funding: number | null;
    continuity: number | null;
  };
  gaps: Array<{ start: number; end: number; missingSources?: string[] }>;
  quality: BclifPersistentCoverage["quality"];
  sourceMode: BclifPersistentCoverage["sourceMode"];
  updatedAt: number;
}

export interface PersistentLiquidationFieldAssemblyContext {
  collectorNodeId: string;
  coverage: PersistentLiquidationFieldCoverageInput;
}

export function preflightPersistentLiquidationManifestMemory(
  tiles: readonly PersistentTileManifestMetadata[],
  maximumBytes: number,
  requestedWindow?: { start: number; end: number }
) {
  const reference = tiles[0];
  if (!reference) return { decodedTileBytes: 0, atlasBytes: 0, columns: 0, rows: 0 };
  let decodedTileBytes = 0;
  let startTime = reference.startTime;
  let endTime = reference.endTime;
  let minPrice = reference.minPrice;
  let maxPrice = reference.maxPrice;
  for (const tile of tiles) {
    if (
      tile.modelVersion !== reference.modelVersion
      || tile.schemaVersion !== reference.schemaVersion
      || tile.timeStepMs !== reference.timeStepMs
      || Math.abs(tile.priceStep - reference.priceStep) > Math.max(1e-8, Math.abs(reference.priceStep) * 1e-7)
    ) {
      throw contract("BCLIF_MANIFEST_GENERATION", "Persistent BCLIF manifest mixes incompatible tile generations or grids.");
    }
    const cells = tile.columns * tile.rows;
    const bytes = cells * 22 + tile.columns * 28;
    if (!Number.isSafeInteger(bytes)) throw contract("BCLIF_MANIFEST_MEMORY", "Persistent BCLIF tile memory estimate overflowed.");
    decodedTileBytes += bytes;
    startTime = Math.min(startTime, tile.startTime);
    endTime = Math.max(endTime, tile.endTime);
    minPrice = Math.min(minPrice, tile.minPrice);
    maxPrice = Math.max(maxPrice, tile.maxPrice);
    if (requestedWindow && tile.sourceCutoffTimestamp > requestedWindow.end + 1) {
      throw contract("BCLIF_MANIFEST_LOOKAHEAD", "Persistent BCLIF tile source cutoff exceeds the requested historical boundary.");
    }
  }
  if (requestedWindow) ({ startTime, endTime } = clipTimeWindow(startTime, endTime, reference.timeStepMs, requestedWindow.start, requestedWindow.end));
  const columns = preflightLatticeLength(startTime, endTime, reference.timeStepMs, "time");
  const rows = preflightLatticeLength(minPrice, maxPrice, reference.priceStep, "price");
  for (const tile of tiles) {
    preflightLatticeOffset(startTime, tile.startTime, reference.timeStepMs, "time");
    preflightLatticeOffset(minPrice, tile.minPrice, reference.priceStep, "price");
  }
  const atlasBytes = columns * rows * 24 + columns * 8;
  if (
    !Number.isSafeInteger(decodedTileBytes)
    || !Number.isSafeInteger(atlasBytes)
    || decodedTileBytes > maximumBytes
    || atlasBytes > maximumBytes
  ) {
    throw contract(
      "BCLIF_MANIFEST_MEMORY",
      `Persistent BCLIF manifest exceeds this device's bounded tile budget (${Math.round(maximumBytes / 1024 / 1024)} MiB).`
    );
  }
  return { decodedTileBytes, atlasBytes, columns, rows };
}

/**
 * Places immutable tiles on their exact time/price lattice. Missing intervals
 * remain validity=0 and overlapping publications resolve deterministically to
 * the newest tileVersion/source cutoff. No interpolation or cross-authority
 * merge is performed.
 */
export function assemblePersistentLiquidationField(
  sourceTiles: readonly DecodedLiquidationFieldTile[],
  context: PersistentLiquidationFieldAssemblyContext
): LiquidationFieldSnapshot {
  const startedAt = performance.now();
  if (!sourceTiles.length) throw contract("BCLIF_ASSEMBLY_EMPTY", "Persistent BCLIF assembly requires at least one verified tile.");
  const tiles = [...sourceTiles].sort((left, right) =>
    left.metadata.tileVersion - right.metadata.tileVersion
      || left.metadata.sourceCutoffTimestamp - right.metadata.sourceCutoffTimestamp
      || left.metadata.tileId.localeCompare(right.metadata.tileId)
  );
  const reference = tiles[0]!.metadata;
  const referenceSourceVersion = tiles[0]!.sourceVersion;
  if (reference.modelVersion !== BCLIF_MODEL_VERSION || referenceSourceVersion !== BCLIF_SOURCE_VERSION) {
    throw contract("BCLIF_ASSEMBLY_VERSION", "Persistent BCLIF tile model/source generation is not supported by this client.");
  }
  const timeStepMs = reference.timeStepMs;
  const priceStep = reference.priceStep;
  for (const tile of tiles) validateCompatibleTile(tile, reference, referenceSourceVersion);

  const rawStartTime = Math.min(...tiles.map((tile) => tile.metadata.startTime));
  const rawEndTime = Math.max(...tiles.map((tile) => tile.metadata.endTime));
  const { startTime, endTime } = clipTimeWindow(
    rawStartTime,
    rawEndTime,
    timeStepMs,
    context.coverage.requestedStart,
    context.coverage.requestedEnd
  );
  const minPrice = Math.min(...tiles.map((tile) => tile.metadata.minPrice));
  const maxPrice = Math.max(...tiles.map((tile) => tile.metadata.maxPrice));
  const columns = latticeLength(startTime, endTime, timeStepMs, "time", MAX_ASSEMBLED_COLUMNS);
  const rows = latticeLength(minPrice, maxPrice, priceStep, "price", MAX_ASSEMBLED_ROWS);
  const cells = columns * rows;
  if (!Number.isSafeInteger(cells) || cells < 1 || cells > MAX_ASSEMBLED_CELLS) {
    throw contract("BCLIF_ASSEMBLY_BOUND", "Persistent BCLIF atlas exceeds the client memory bound.");
  }

  const timestamps = new Float64Array(columns);
  for (let column = 0; column < columns; column++) timestamps[column] = startTime + column * timeStepMs;
  const longExposure = new Float32Array(cells);
  const shortExposure = new Float32Array(cells);
  const combinedExposure = new Float32Array(cells);
  const normalizedIntensity = new Uint8Array(cells);
  const longNormalizedIntensity = new Uint8Array(cells);
  const shortNormalizedIntensity = new Uint8Array(cells);
  const confidence = new Uint8Array(cells);
  const validity = new Uint8Array(cells);
  const confirmedIntensity = new Uint8Array(cells);
  const confirmedNotional = new Float32Array(cells);
  const confirmedCount = new Uint16Array(cells);

  for (const tile of tiles) {
    if (tile.metadata.sourceCutoffTimestamp > context.coverage.requestedEnd + 1) {
      throw contract("BCLIF_ASSEMBLY_LOOKAHEAD", "Persistent BCLIF tile source cutoff exceeds the requested historical boundary.");
    }
    const columnOffset = latticeOffset(startTime, tile.metadata.startTime, timeStepMs, "time");
    const rowOffset = latticeOffset(minPrice, tile.metadata.minPrice, priceStep, "price");
    for (let tileColumn = 0; tileColumn < tile.metadata.columns; tileColumn++) {
      const targetColumn = columnOffset + tileColumn;
      if (targetColumn < 0 || targetColumn >= columns) continue;
      for (let tileRow = 0; tileRow < tile.metadata.rows; tileRow++) {
        const targetRow = rowOffset + tileRow;
        if (targetRow < 0 || targetRow >= rows) throw contract("BCLIF_PRICE_BOUNDS", "BCLIF tile escaped the assembled price lattice.");
        const sourceIndex = tileColumn * tile.metadata.rows + tileRow;
        const targetIndex = targetColumn * rows + targetRow;
        longExposure[targetIndex] = tile.longExposure[sourceIndex]!;
        shortExposure[targetIndex] = tile.shortExposure[sourceIndex]!;
        combinedExposure[targetIndex] = tile.combinedExposure[sourceIndex]!;
        normalizedIntensity[targetIndex] = tile.normalizedIntensity[sourceIndex]!;
        longNormalizedIntensity[targetIndex] = causalSideIntensity(
          tile.longExposure[sourceIndex]!,
          tile.longExposureScale[tileColumn]!
        );
        shortNormalizedIntensity[targetIndex] = causalSideIntensity(
          tile.shortExposure[sourceIndex]!,
          tile.shortExposureScale[tileColumn]!
        );
        confidence[targetIndex] = tile.confidence[sourceIndex]!;
        validity[targetIndex] = tile.validity[sourceIndex]!;
        confirmedIntensity[targetIndex] = tile.confirmedIntensity[sourceIndex]!;
        confirmedNotional[targetIndex] = tile.confirmedNotional[sourceIndex]!;
        confirmedCount[targetIndex] = tile.confirmedCount[sourceIndex]!;
      }
    }
  }

  const persistentCoverage = toPersistentCoverage(context.coverage);
  applyCoverageConfidence(persistentCoverage, confidence, validity);
  applyCoverageGaps(
    persistentCoverage.gaps,
    timestamps,
    rows,
    validity,
    confidence,
    normalizedIntensity,
    confirmedIntensity
  );
  const coverage = toLegacyCoverage(persistentCoverage);
  const confidenceTotal = meanConfidence(confidence, validity);
  const certainty = certaintyFor(persistentCoverage.quality, confidenceTotal);
  const exposureScale = Math.max(1, ...tiles.map((tile) => Math.max(
    tile.metadata.scaleMetadata ? finiteScale(tile.metadata.scaleMetadata.combinedExposure) : 0,
    maximum(tile.combinedExposure)
  )));
  const sourceCutoffTimestamp = Math.max(...tiles.map((tile) => tile.metadata.sourceCutoffTimestamp));
  const tileVersion = Math.max(...tiles.map((tile) => tile.metadata.tileVersion));

  return {
    header: {
      schemaVersion: reference.schemaVersion,
      modelVersion: reference.modelVersion,
      venue: reference.venue,
      symbol: reference.symbol,
      horizon: reference.horizon,
      startTime,
      endTime,
      minPrice,
      maxPrice,
      columns,
      rows,
      timeStepMs,
      priceStep,
      exposureScale,
      confidenceScale: 255,
      compression: "bclif-gzip-u16-log-v2",
      checksum: `manifest:${tiles.map((tile) => `${tile.metadata.tileId}@${tile.metadata.checksum}`).join("|")}`,
      sourceCutoffTimestamp,
      tileId: tiles.length === 1 ? reference.tileId : `atlas-${tiles.length}`,
      tileVersion
    },
    timestamps,
    longExposure,
    shortExposure,
    combinedExposure,
    normalizedIntensity,
    longNormalizedIntensity,
    shortNormalizedIntensity,
    confidence,
    validity,
    confirmedIntensity,
    confirmedNotional,
    confirmedCount,
    cohorts: [],
    massLedger: {
      totalCreatedMass: 0,
      voluntaryClosureMass: 0,
      confirmedLiquidationMass: 0,
      decayExpiryMass: 0,
      totalRemainingMass: 0,
      conservationError: 0,
      tolerance: 0.01
    },
    lifecycleEvents: [],
    confirmedEvents: [],
    cascade: [],
    coverage,
    persistentCoverage,
    confidenceBreakdown: {
      total: confidenceTotal,
      tradeCoverage: percentOrZero(persistentCoverage.tradeCoveragePercent),
      openInterest: percentOrZero(persistentCoverage.openInterestCoveragePercent),
      entryPrice: Math.min(percentOrZero(persistentCoverage.tradeCoveragePercent), percentOrZero(persistentCoverage.openInterestCoveragePercent)),
      leverage: confidenceTotal,
      marginModel: confidenceTotal,
      eventCalibration: percentOrZero(persistentCoverage.liquidationCoveragePercent),
      continuity: percentOrZero(persistentCoverage.continuityPercent),
      penalties: coveragePenalties(persistentCoverage)
    },
    buildTimeMs: performance.now() - startedAt,
    generatedAt: context.coverage.updatedAt,
    certainty,
    authority: "PERSISTENT_NODE",
    collectorNodeId: context.collectorNodeId
  };
}

function validateCompatibleTile(
  tile: DecodedLiquidationFieldTile,
  reference: DecodedLiquidationFieldTile["metadata"],
  referenceSourceVersion: string
) {
  const metadata = tile.metadata;
  for (const [name, actual, expected] of [
    ["venue", metadata.venue, reference.venue],
    ["symbol", metadata.symbol, reference.symbol],
    ["horizon", metadata.horizon, reference.horizon],
    ["modelVersion", metadata.modelVersion, reference.modelVersion],
    ["schemaVersion", metadata.schemaVersion, reference.schemaVersion],
    ["authority", metadata.modelAuthority, "PERSISTENT_NODE"]
  ] as const) {
    if (actual !== expected) throw contract("BCLIF_ASSEMBLY_MISMATCH", `BCLIF tile ${name} does not match the atlas authority.`);
  }
  if (tile.sourceVersion !== referenceSourceVersion || tile.sourceVersion !== BCLIF_SOURCE_VERSION) {
    throw contract("BCLIF_SOURCE_VERSION", "BCLIF atlas cannot stitch mixed or unsupported source adapter generations.");
  }
  close(metadata.timeStepMs, reference.timeStepMs, "time step", Math.max(1, reference.timeStepMs * 1e-6));
  close(metadata.priceStep, reference.priceStep, "price step");
  close(metadata.maxPrice, metadata.minPrice + (metadata.rows - 1) * metadata.priceStep, "tile price lattice");
  close(metadata.endTime, metadata.startTime + (metadata.columns - 1) * metadata.timeStepMs, "tile time lattice", 1);
}

function toPersistentCoverage(input: PersistentLiquidationFieldCoverageInput): BclifPersistentCoverage {
  const gaps = input.gaps.map((gap) => ({
    start: finiteTime(gap.start),
    end: finiteTime(gap.end),
    missingSources: Array.isArray(gap.missingSources)
      ? gap.missingSources.filter((item): item is string => typeof item === "string").slice(0, 16)
      : []
  }));
  return {
    venue: input.venue,
    symbol: input.symbol,
    horizon: input.horizon,
    requestedStart: input.requestedStart,
    requestedEnd: input.requestedEnd,
    modelStart: input.modelStart,
    modelEnd: input.modelEnd,
    openInterestCoveragePercent: nullablePercent(input.coverage.openInterest),
    tradeCoveragePercent: nullablePercent(input.coverage.trades),
    liquidationCoveragePercent: nullablePercent(input.coverage.liquidations),
    orderbookCoveragePercent: nullablePercent(input.coverage.orderbook),
    fundingCoveragePercent: nullablePercent(input.coverage.funding),
    continuityPercent: nullablePercent(input.coverage.continuity),
    sourceMode: input.sourceMode,
    quality: input.quality,
    gaps,
    updatedAt: input.updatedAt
  };
}

function toLegacyCoverage(persistent: BclifPersistentCoverage): LiquidationCoverage {
  return {
    venue: persistent.venue,
    symbol: persistent.symbol,
    horizon: persistent.horizon,
    requestedStart: persistent.requestedStart,
    requestedEnd: persistent.requestedEnd,
    availableStart: persistent.modelStart,
    availableEnd: persistent.modelEnd,
    observedTradeCoveragePercent: percentOrZero(persistent.tradeCoveragePercent),
    openInterestCoveragePercent: percentOrZero(persistent.openInterestCoveragePercent),
    liquidationEventCoveragePercent: percentOrZero(persistent.liquidationCoveragePercent),
    orderbookCoveragePercent: percentOrZero(persistent.orderbookCoveragePercent),
    modelContinuityPercent: percentOrZero(persistent.continuityPercent),
    missingIntervals: persistent.gaps.map(({ start, end }) => ({ start, end })),
    quality: persistent.quality,
    state: persistent.sourceMode === "UNAVAILABLE" ? "UNAVAILABLE" : "LIVE"
  };
}

function causalSideIntensity(exposure: number, columnScale: number) {
  if (!Number.isFinite(exposure) || exposure <= 0) return 0;
  if (!Number.isFinite(columnScale) || columnScale <= 0) {
    throw contract("BCLIF_COLUMN_SCALE_INVALID", "Persistent BCLIF side intensity requires a finite causal column scale.");
  }
  const unit = Math.log1p(exposure) / Math.max(1e-9, Math.log1p(columnScale));
  return Math.max(0, Math.min(255, Math.round(255 * unit)));
}

function meanConfidence(confidence: Uint8Array, validity: Uint8Array) {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < confidence.length; index++) {
    if (!validity[index]) continue;
    sum += confidence[index]!;
    count += 1;
  }
  return count ? Math.round(sum / count / 2.55) : 0;
}

function applyCoverageConfidence(
  coverage: BclifPersistentCoverage,
  confidence: Uint8Array,
  validity: Uint8Array
) {
  const weightedMetrics = [
    [coverage.tradeCoveragePercent, 0.2],
    [coverage.openInterestCoveragePercent, 0.25],
    [coverage.liquidationCoveragePercent, 0.15],
    [coverage.orderbookCoveragePercent, 0.1],
    [coverage.fundingCoveragePercent, 0.1],
    [coverage.continuityPercent, 0.2]
  ] as const;
  let factor = 0;
  for (const [value, weight] of weightedMetrics) {
    const sourceFactor = value === null ? 0.65 : 0.2 + 0.8 * Math.max(0, Math.min(1, value / 100));
    factor += sourceFactor * weight;
  }
  if (factor >= 0.9999) return;
  for (let index = 0; index < confidence.length; index++) {
    if (!validity[index]) continue;
    confidence[index] = Math.round(confidence[index]! * factor);
  }
}

function applyCoverageGaps(
  gaps: ReadonlyArray<BclifPersistentCoverage["gaps"][number]>,
  timestamps: Float64Array,
  rows: number,
  validity: Uint8Array,
  confidence: Uint8Array,
  normalizedIntensity: Uint8Array,
  confirmedIntensity: Uint8Array
) {
  if (!gaps.length) return;
  for (const gap of gaps) {
    const sources = gap.missingSources.map((source) => source.toUpperCase());
    const explicitSources = sources.filter((source) => !source.endsWith("_COVERAGE_UNKNOWN"));
    const hardMissing = sources.length === 0 || explicitSources.some((source) =>
      source.includes("OPEN_INTEREST") || source.includes("CONTINUITY") || source.includes("MODEL_FRAME")
    );
    const liquidationMissing = explicitSources.some((source) => source.includes("LIQUIDATION"));
    const confidenceFactor = hardMissing
      ? 0
      : explicitSources.some((source) => source === "TRADE" || source.includes("TRADES"))
        ? 0.72
        : explicitSources.some((source) => source === "BOOK_FRAME" || source.includes("ORDERBOOK"))
          ? 0.84
          : explicitSources.some((source) => source.includes("FUNDING"))
            ? 0.9
            : 0.86;
    for (let column = 0; column < timestamps.length; column++) {
      const timestamp = timestamps[column]!;
      if (timestamp < gap.start || timestamp >= gap.end) continue;
      const start = column * rows;
      const end = start + rows;
      if (hardMissing) {
        validity.fill(0, start, end);
        confidence.fill(0, start, end);
        normalizedIntensity.fill(0, start, end);
        confirmedIntensity.fill(0, start, end);
        continue;
      }
      for (let index = start; index < end; index++) {
        confidence[index] = Math.round(confidence[index]! * confidenceFactor);
      }
      if (liquidationMissing) confirmedIntensity.fill(0, start, end);
    }
  }
}

function certaintyFor(quality: BclifPersistentCoverage["quality"], confidence: number): LiquidationDataCertainty {
  if (confidence <= 0) return "MISSING";
  if (quality === "INSUFFICIENT") return "ESTIMATED_LOW";
  if (quality === "EXCELLENT" || (quality === "HIGH" && confidence >= 75)) return "ESTIMATED_HIGH";
  if (quality === "HIGH" || quality === "MIXED") return "ESTIMATED_MEDIUM";
  return "ESTIMATED_LOW";
}

function coveragePenalties(coverage: BclifPersistentCoverage) {
  const metrics = [
    coverage.tradeCoveragePercent,
    coverage.openInterestCoveragePercent,
    coverage.liquidationCoveragePercent,
    coverage.orderbookCoveragePercent,
    coverage.fundingCoveragePercent,
    coverage.continuityPercent
  ];
  const penalties: string[] = [];
  if (metrics.some((value) => value === null)) penalties.push("Unknown requested-window coverage reduces confidence without erasing verified tile cells.");
  if (metrics.some((value) => value !== null && value < 100)) penalties.push("Partial requested-window coverage reduces confidence.");
  if (coverage.gaps.length) penalties.push("Explicit critical source gaps remain visibly unavailable; secondary gaps reduce confidence.");
  return penalties;
}

function latticeLength(minimum: number, maximum: number, step: number, name: string, maximumLength: number) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !Number.isFinite(step) || maximum < minimum || step <= 0) {
    throw contract("BCLIF_LATTICE", `BCLIF ${name} lattice is invalid.`);
  }
  const intervals = (maximum - minimum) / step;
  const rounded = Math.round(intervals);
  close(intervals, rounded, `${name} lattice alignment`, 1e-5);
  const length = rounded + 1;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximumLength) {
    throw contract("BCLIF_LATTICE_BOUND", `BCLIF ${name} lattice exceeds the renderer bound.`);
  }
  return length;
}

function latticeOffset(origin: number, value: number, step: number, name: string) {
  const offset = (value - origin) / step;
  const rounded = Math.round(offset);
  close(offset, rounded, `${name} tile alignment`, 1e-5);
  return rounded;
}

function preflightLatticeLength(minimum: number, maximum: number, step: number, name: string) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !Number.isFinite(step) || step <= 0 || maximum < minimum) {
    throw contract("BCLIF_MANIFEST_LATTICE", `Persistent BCLIF ${name} lattice is invalid.`);
  }
  const intervals = (maximum - minimum) / step;
  const rounded = Math.round(intervals);
  if (Math.abs(intervals - rounded) > 1e-5) {
    throw contract("BCLIF_MANIFEST_LATTICE", `Persistent BCLIF ${name} lattice is misaligned.`);
  }
  const length = rounded + 1;
  if (!Number.isSafeInteger(length) || length < 1) {
    throw contract("BCLIF_MANIFEST_LATTICE", `Persistent BCLIF ${name} lattice is invalid.`);
  }
  return length;
}

function preflightLatticeOffset(origin: number, value: number, step: number, name: string) {
  const offset = (value - origin) / step;
  if (!Number.isFinite(offset) || Math.abs(offset - Math.round(offset)) > 1e-5) {
    throw contract("BCLIF_MANIFEST_LATTICE", `Persistent BCLIF ${name} tile offset is misaligned.`);
  }
}

function clipTimeWindow(
  availableStart: number,
  availableEnd: number,
  step: number,
  requestedStart: number,
  requestedEnd: number
) {
  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd < requestedStart) {
    throw contract("BCLIF_REQUEST_WINDOW", "Persistent BCLIF requested time window is invalid.");
  }
  const firstOffset = Math.max(0, Math.ceil((requestedStart - availableStart) / step - 1e-8));
  const lastOffset = Math.min(
    Math.round((availableEnd - availableStart) / step),
    Math.floor((requestedEnd - availableStart) / step + 1e-8)
  );
  if (lastOffset < firstOffset) {
    throw contract("BCLIF_REQUEST_WINDOW_EMPTY", "Persistent BCLIF tiles do not contain a lattice column inside the requested window.");
  }
  return {
    startTime: availableStart + firstOffset * step,
    endTime: availableStart + lastOffset * step
  };
}

function nullablePercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
}

function percentOrZero(value: number | null) {
  return value ?? 0;
}

function finiteTime(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function finiteScale(value: unknown) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

function maximum(values: Float32Array) {
  let result = 0;
  for (const value of values) if (value > result) result = value;
  return result;
}

function close(actual: number, expected: number, name: string, tolerance = Math.max(1e-8, Math.abs(expected) * 1e-7)) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > tolerance) {
    throw contract("BCLIF_LATTICE_MISMATCH", `BCLIF ${name} is inconsistent.`);
  }
}

function contract(code: string, message: string) {
  return new LiquidationFieldTileContractError(code, message);
}
