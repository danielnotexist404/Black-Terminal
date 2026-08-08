import { BCLIF_MODEL_VERSION, BCLIF_SOURCE_VERSION, type BclifModelAuthority } from "../core/types.ts";

const BCLIF_MAGIC = [0x42, 0x43, 0x4c, 0x46] as const; // BCLF
const BCLIF_ENVELOPE_BYTES = 52;
const BCLIF_GZIP_FLAG = 1;
const BCLIF_SCHEMA_VERSION = 2;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
const MAX_COLUMNS = 4_096;
const MAX_ROWS = 1_024;
const MAX_CELLS = 8_388_608;

export interface PersistentTileManifestMetadata {
  tileId: string;
  venue: string;
  symbol: string;
  horizon: string;
  startTime: number;
  endTime: number;
  minPrice: number;
  maxPrice: number;
  timeStepMs: number;
  priceStep: number;
  columns: number;
  rows: number;
  modelVersion: string;
  schemaVersion: number;
  tileVersion: number;
  checksum: string;
  compressedBytes: number;
  sourceCutoffTimestamp: number;
  coverageQuality: string;
  modelAuthority: BclifModelAuthority;
  publicationState?: "FINALIZED" | "STAGING";
  channelManifest?: Record<string, unknown>;
  scaleMetadata?: Record<string, unknown>;
  publishedAt?: string;
}

interface BclifCodecHeader {
  schemaVersion: number;
  tileId: string;
  modelVersion: string;
  sourceVersion: string;
  authority: BclifModelAuthority;
  venue: string;
  symbol: string;
  marketKind: string;
  horizon: string;
  tileVersion: number;
  startTime: number;
  endTime: number;
  minPrice: number;
  maxPrice: number;
  timeStepMs: number;
  priceStep: number;
  columns: number;
  rows: number;
  sourceCutoffTimestamp: number;
  channelOrder: string[];
  scales: {
    longExposure: number;
    shortExposure: number;
    combinedExposure: number;
  };
}

export interface DecodedLiquidationFieldTile {
  metadata: PersistentTileManifestMetadata;
  sourceVersion: string;
  timestamps: Float64Array;
  longExposure: Float32Array;
  shortExposure: Float32Array;
  combinedExposure: Float32Array;
  normalizedIntensity: Uint8Array;
  confidence: Uint8Array;
  validity: Uint8Array;
  confirmedIntensity: Uint8Array;
  confirmedNotional: Float32Array;
  confirmedCount: Uint16Array;
  causalNormalizationLow: Float32Array | null;
  causalNormalizationHigh: Float32Array | null;
  longExposureScale: Float32Array;
  shortExposureScale: Float32Array;
  combinedExposureScale: Float32Array;
  decodedBytes: number;
}

export class LiquidationFieldTileContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LiquidationFieldTileContractError";
    this.code = code;
  }
}

export class LiquidationFieldTileCodecUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiquidationFieldTileCodecUnavailableError";
  }
}

export async function decodeLiquidationFieldTile(
  bytes: ArrayBuffer,
  expected: PersistentTileManifestMetadata
): Promise<DecodedLiquidationFieldTile> {
  const envelope = new Uint8Array(bytes);
  if (envelope.byteLength < BCLIF_ENVELOPE_BYTES) fail("BCLIF_TRUNCATED", "BCLIF tile envelope is truncated.");
  for (let index = 0; index < BCLIF_MAGIC.length; index++) {
    if (envelope[index] !== BCLIF_MAGIC[index]) fail("BCLIF_MAGIC", "BCLIF tile magic is invalid.");
  }
  if (!globalThis.crypto?.subtle) {
    throw new LiquidationFieldTileCodecUnavailableError("This browser cannot verify BCLIF tile checksums.");
  }

  const view = new DataView(bytes);
  const schemaVersion = view.getUint16(4, true);
  const flags = view.getUint16(6, true);
  const headerLength = view.getUint32(8, true);
  const compressedLength = view.getUint32(12, true);
  const uncompressedLength = view.getUint32(16, true);
  integerInRange(schemaVersion, "schemaVersion", BCLIF_SCHEMA_VERSION, BCLIF_SCHEMA_VERSION);
  if (flags !== BCLIF_GZIP_FLAG) fail("BCLIF_FLAGS", "BCLIF tile compression flags are unsupported.");
  integerInRange(headerLength, "headerLength", 2, MAX_HEADER_BYTES);
  integerInRange(compressedLength, "compressedLength", 1, MAX_COMPRESSED_BYTES);
  integerInRange(uncompressedLength, "uncompressedLength", 1, MAX_UNCOMPRESSED_BYTES);
  if (BCLIF_ENVELOPE_BYTES + headerLength + compressedLength !== envelope.byteLength) {
    fail("BCLIF_LENGTH", "BCLIF tile contains truncated or trailing bytes.");
  }
  if (expected.schemaVersion !== schemaVersion) fail("BCLIF_SCHEMA", "BCLIF manifest and envelope schema versions differ.");
  if (expected.compressedBytes > 0 && expected.compressedBytes !== envelope.byteLength) {
    fail("BCLIF_COMPRESSED_LENGTH", "BCLIF manifest and downloaded byte lengths differ.");
  }
  await verifySha256(envelope, expected.checksum, "BCLIF_OUTER_CHECKSUM");

  const headerStart = BCLIF_ENVELOPE_BYTES;
  const headerEnd = headerStart + headerLength;
  const headerText = decodeUtf8(envelope.subarray(headerStart, headerEnd));
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(headerText);
  } catch {
    fail("BCLIF_HEADER_JSON", "BCLIF tile metadata is not valid JSON.");
  }
  if (canonicalJson(rawHeader) !== headerText) {
    fail("BCLIF_HEADER_CANONICAL", "BCLIF tile metadata is not canonical JSON.");
  }
  const header = parseCodecHeader(rawHeader);
  validateHeaderAgainstManifest(header, expected);

  const compressed = envelope.subarray(headerEnd);
  const payload = await decompressGzipBounded(compressed, uncompressedLength);
  await verifySha256(payload, `sha256:${toHex(envelope.subarray(20, 52))}`, "BCLIF_PAYLOAD_CHECKSUM");

  const cells = checkedCells(header.columns, header.rows);
  const requiredBase = header.columns * 8 + cells * 2 * 3 + cells * 3;
  const requiredWithBounds = requiredBase + header.columns * 4 * 2;
  const requiredWithColumnScales = requiredWithBounds + header.columns * 4 * 3;
  const requiredWithConfirmedQuantitative = requiredWithColumnScales + cells * 4 + cells * 2;
  if (payload.byteLength === requiredBase) {
    fail("BCLIF_CAUSAL_BOUNDS_REQUIRED", "Persistent BCLIF tiles must carry causal normalization bounds for every column.");
  }
  if (payload.byteLength === requiredWithBounds) {
    fail("BCLIF_COLUMN_SCALES_REQUIRED", "Persistent BCLIF tiles must carry causal per-column exposure scales.");
  }
  if (payload.byteLength === requiredWithColumnScales) {
    fail("BCLIF_CONFIRMED_QUANTITATIVE_REQUIRED", "Persistent BCLIF tiles must carry quantitative confirmed-liquidation channels.");
  }
  if (payload.byteLength !== requiredWithConfirmedQuantitative) {
    fail("BCLIF_PAYLOAD_LENGTH", "BCLIF tile channel payload length is invalid.");
  }
  validateChannelOrder(header.channelOrder);

  const decoded = decodeChannels(payload, header, cells);
  validateTimestamps(decoded.timestamps, header);
  return {
    metadata: expected,
    sourceVersion: header.sourceVersion,
    ...decoded,
    decodedBytes: decoded.timestamps.byteLength
      + decoded.longExposure.byteLength
      + decoded.shortExposure.byteLength
      + decoded.combinedExposure.byteLength
      + decoded.normalizedIntensity.byteLength
      + decoded.confidence.byteLength
      + decoded.validity.byteLength
      + decoded.confirmedIntensity.byteLength
      + decoded.confirmedNotional.byteLength
      + decoded.confirmedCount.byteLength
      + (decoded.causalNormalizationLow?.byteLength ?? 0)
      + (decoded.causalNormalizationHigh?.byteLength ?? 0)
      + decoded.longExposureScale.byteLength
      + decoded.shortExposureScale.byteLength
      + decoded.combinedExposureScale.byteLength
  };
}

function decodeChannels(payload: Uint8Array, header: BclifCodecHeader, cells: number) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const timestamps = new Float64Array(header.columns);
  for (let index = 0; index < timestamps.length; index++, offset += 8) {
    timestamps[index] = view.getFloat64(offset, true);
  }
  const longExposureOffset = offset;
  offset += cells * 2;
  const shortExposureOffset = offset;
  offset += cells * 2;
  const combinedExposureOffset = offset;
  offset += cells * 2;
  const confidence = payload.slice(offset, offset + cells);
  offset += cells;
  const validity = payload.slice(offset, offset + cells);
  offset += cells;
  const confirmedIntensity = payload.slice(offset, offset + cells);
  offset += cells;
  const causalNormalizationLow = new Float32Array(header.columns);
  const causalNormalizationHigh = new Float32Array(header.columns);
  const longExposureScale = new Float32Array(header.columns);
  const shortExposureScale = new Float32Array(header.columns);
  const combinedExposureScale = new Float32Array(header.columns);
  for (let column = 0; column < header.columns; column++, offset += 4) {
    causalNormalizationLow[column] = view.getFloat32(offset, true);
  }
  for (let column = 0; column < header.columns; column++, offset += 4) {
    causalNormalizationHigh[column] = view.getFloat32(offset, true);
  }
  for (const scales of [longExposureScale, shortExposureScale, combinedExposureScale]) {
    for (let column = 0; column < header.columns; column++, offset += 4) {
      const scale = view.getFloat32(offset, true);
      if (!Number.isFinite(scale) || scale <= 0) {
        fail("BCLIF_COLUMN_SCALE_INVALID", "Persistent BCLIF per-column exposure scales must be finite and positive.");
      }
      scales[column] = scale;
    }
  }
  const confirmedNotional = new Float32Array(cells);
  for (let index = 0; index < cells; index++, offset += 4) {
    const notional = view.getFloat32(offset, true);
    if (!Number.isFinite(notional) || notional < 0) {
      fail("BCLIF_CONFIRMED_NOTIONAL_INVALID", "Persistent BCLIF confirmed notional must be finite and non-negative.");
    }
    confirmedNotional[index] = notional;
  }
  const confirmedCount = new Uint16Array(cells);
  for (let index = 0; index < cells; index++, offset += 2) {
    const count = view.getUint16(offset, true);
    const notional = confirmedNotional[index]!;
    if ((count === 0 && notional !== 0) || (count > 0 && notional === 0)) {
      fail("BCLIF_CONFIRMED_QUANTITATIVE_INVALID", "Persistent BCLIF confirmed count and notional channels disagree.");
    }
    if (notional === 0 && confirmedIntensity[index] !== 0) {
      fail("BCLIF_CONFIRMED_INTENSITY_INVALID", "Persistent BCLIF confirmed display intensity has no quantitative event support.");
    }
    confirmedCount[index] = count;
  }
  if (offset !== payload.byteLength) fail("BCLIF_CHANNEL_TRAILING_BYTES", "BCLIF channel decoder did not consume the exact payload.");

  const longExposure = decodeLogU16ByColumn(view, longExposureOffset, header.columns, header.rows, longExposureScale);
  const shortExposure = decodeLogU16ByColumn(view, shortExposureOffset, header.columns, header.rows, shortExposureScale);
  const combinedExposure = decodeLogU16ByColumn(view, combinedExposureOffset, header.columns, header.rows, combinedExposureScale);

  const normalizedIntensity = new Uint8Array(cells);
  for (let column = 0; column < header.columns; column++) {
    const low = causalNormalizationLow?.[column];
    const high = causalNormalizationHigh?.[column];
    if (!Number.isFinite(low) || !Number.isFinite(high) || high! <= low!) {
      fail("BCLIF_CAUSAL_BOUNDS_INVALID", "Persistent BCLIF causal normalization bounds are invalid.");
    }
    for (let row = 0; row < header.rows; row++) {
      const index = column * header.rows + row;
      if (!validity[index]) continue;
      const logged = Math.log1p(Math.max(0, combinedExposure[index]!));
      normalizedIntensity[index] = Math.round(255 * clamp01((logged - low!) / (high! - low!)));
    }
  }
  return {
    timestamps,
    longExposure,
    shortExposure,
    combinedExposure,
    normalizedIntensity,
    confidence,
    validity,
    confirmedIntensity,
    confirmedNotional,
    confirmedCount,
    causalNormalizationLow,
    causalNormalizationHigh,
    longExposureScale,
    shortExposureScale,
    combinedExposureScale
  };
}

function decodeLogU16ByColumn(view: DataView, offset: number, columns: number, rows: number, scales: Float32Array) {
  const decoded = new Float32Array(columns * rows);
  for (let column = 0; column < columns; column++) {
    const logarithmicScale = Math.log1p(scales[column]!);
    for (let row = 0; row < rows; row++) {
      const index = column * rows + row;
      const code = view.getUint16(offset + index * 2, true);
      const value = Math.expm1(code / 65_535 * logarithmicScale);
      if (!Number.isFinite(value) || value < 0) fail("BCLIF_EXPOSURE_VALUE", "BCLIF exposure channel contains an invalid value.");
      decoded[index] = value;
    }
  }
  return decoded;
}

async function decompressGzipBounded(compressed: Uint8Array, expectedLength: number) {
  if (typeof DecompressionStream === "undefined") {
    throw new LiquidationFieldTileCodecUnavailableError("This browser cannot decode persistent BCLIF gzip tiles.");
  }
  const stream = new Blob([ownedArrayBuffer(compressed)]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedLength || total > MAX_UNCOMPRESSED_BYTES) {
        await reader.cancel("BCLIF decompression exceeded its declared bound.");
        fail("BCLIF_DECOMPRESSION_BOUND", "BCLIF decompression exceeded its declared bound.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof LiquidationFieldTileContractError) throw error;
    fail("BCLIF_GZIP", "BCLIF gzip payload could not be decoded.");
  }
  if (total !== expectedLength) fail("BCLIF_UNCOMPRESSED_LENGTH", "BCLIF uncompressed payload length differs from its envelope.");
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function parseCodecHeader(value: unknown): BclifCodecHeader {
  const header = object(value, "header");
  const scalesObject = object(header.scales, "scales");
  const rawOrder = header.channelOrder;
  if (!Array.isArray(rawOrder) || rawOrder.some((item) => typeof item !== "string")) {
    fail("BCLIF_CHANNEL_MANIFEST", "BCLIF channel order is missing or invalid.");
  }
  return {
    schemaVersion: integer(header.schemaVersion, "schemaVersion"),
    tileId: text(header.tileId, "tileId"),
    modelVersion: text(header.modelVersion, "modelVersion"),
    sourceVersion: text(header.sourceVersion, "sourceVersion"),
    authority: text(header.authority, "authority") as BclifModelAuthority,
    venue: text(header.venue, "venue").toUpperCase(),
    symbol: text(header.symbol, "symbol").toUpperCase(),
    marketKind: text(header.marketKind, "marketKind"),
    horizon: text(header.horizon, "horizon").toUpperCase(),
    tileVersion: integer(header.tileVersion, "tileVersion"),
    startTime: finite(header.startTime, "startTime"),
    endTime: finite(header.endTime, "endTime"),
    minPrice: finite(header.minPrice, "minPrice"),
    maxPrice: finite(header.maxPrice, "maxPrice"),
    timeStepMs: finite(header.timeStepMs, "timeStepMs"),
    priceStep: finite(header.priceStep, "priceStep"),
    columns: integer(header.columns, "columns"),
    rows: integer(header.rows, "rows"),
    sourceCutoffTimestamp: finite(header.sourceCutoffTimestamp, "sourceCutoffTimestamp"),
    channelOrder: rawOrder as string[],
    scales: {
      longExposure: positiveScale(scalesObject.longExposure, "longExposure"),
      shortExposure: positiveScale(scalesObject.shortExposure, "shortExposure"),
      combinedExposure: positiveScale(scalesObject.combinedExposure, "combinedExposure")
    }
  };
}

function validateHeaderAgainstManifest(header: BclifCodecHeader, expected: PersistentTileManifestMetadata) {
  integerInRange(header.schemaVersion, "schemaVersion", BCLIF_SCHEMA_VERSION, BCLIF_SCHEMA_VERSION);
  integerInRange(header.columns, "columns", 1, MAX_COLUMNS);
  integerInRange(header.rows, "rows", 1, MAX_ROWS);
  checkedCells(header.columns, header.rows);
  if (header.authority !== "PERSISTENT_NODE" || expected.modelAuthority !== "PERSISTENT_NODE") {
    fail("BCLIF_AUTHORITY", "A persistent tile declared a non-persistent model authority.");
  }
  if (header.modelVersion !== BCLIF_MODEL_VERSION || header.sourceVersion !== BCLIF_SOURCE_VERSION) {
    fail("BCLIF_UNSUPPORTED_VERSION", "BCLIF tile model/source generation is not supported by this client.");
  }
  if (header.marketKind !== "linear_perpetual") fail("BCLIF_MARKET_KIND", "BCLIF tile market kind is unsupported.");
  equal(header.tileId.toLowerCase(), expected.tileId.toLowerCase(), "tileId");
  equal(header.modelVersion, expected.modelVersion, "modelVersion");
  equal(header.schemaVersion, expected.schemaVersion, "schemaVersion");
  equal(header.tileVersion, expected.tileVersion, "tileVersion");
  equal(header.venue, expected.venue.toUpperCase(), "venue");
  equal(header.symbol, expected.symbol.toUpperCase(), "symbol");
  equal(header.horizon, expected.horizon.toUpperCase(), "horizon");
  equal(header.columns, expected.columns, "columns");
  equal(header.rows, expected.rows, "rows");
  close(header.startTime, expected.startTime, "startTime", 1);
  close(header.endTime, expected.endTime, "endTime", 1);
  close(header.minPrice, expected.minPrice, "minPrice");
  close(header.maxPrice, expected.maxPrice, "maxPrice");
  close(header.timeStepMs, expected.timeStepMs, "timeStepMs", 1);
  close(header.priceStep, expected.priceStep, "priceStep");
  close(header.sourceCutoffTimestamp, expected.sourceCutoffTimestamp, "sourceCutoffTimestamp", 1);
  if (header.startTime > header.endTime || header.minPrice >= header.maxPrice || header.timeStepMs <= 0 || header.priceStep <= 0) {
    fail("BCLIF_HEADER_RANGE", "BCLIF header bounds are invalid.");
  }
  if (header.sourceCutoffTimestamp + 1 < header.endTime) {
    fail("BCLIF_CUTOFF_RANGE", "BCLIF tile source cutoff precedes the finalized tile boundary.");
  }
}

function validateChannelOrder(order: readonly string[]) {
  const required = [
    "timestamps", "longExposure", "shortExposure", "combinedExposure", "confidence", "validity", "confirmedIntensity",
    "causalNormalizationLow", "causalNormalizationHigh", "longExposureScale", "shortExposureScale", "combinedExposureScale",
    "confirmedNotional", "confirmedCount"
  ];
  for (let index = 0; index < required.length; index++) {
    if (order[index] !== required[index]) {
      fail("BCLIF_CHANNEL_ORDER", "BCLIF tile channel order is incompatible with this renderer.");
    }
  }
  if (order.length !== required.length) fail("BCLIF_CHANNEL_COUNT", "BCLIF tile declares unexpected channels.");
}

function validateTimestamps(timestamps: Float64Array, header: BclifCodecHeader) {
  if (!timestamps.length) fail("BCLIF_TIMESTAMPS", "BCLIF tile contains no timestamps.");
  close(timestamps[0]!, header.startTime, "first timestamp", 1);
  close(timestamps.at(-1)!, header.endTime, "last timestamp", 1);
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index]!;
    if (!Number.isFinite(timestamp)) fail("BCLIF_TIMESTAMP_VALUE", "BCLIF tile contains a non-finite timestamp.");
    if (index > 0) {
      const delta = timestamp - timestamps[index - 1]!;
      close(delta, header.timeStepMs, "timestamp step", Math.max(1, header.timeStepMs * 1e-6));
    }
  }
}

async function verifySha256(bytes: Uint8Array, expected: string, code: string) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(expected);
  if (!match) fail(code, "BCLIF checksum metadata is invalid.");
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)));
  const expectedBytes = hexToBytes(match![1]!);
  let mismatch = actual.byteLength ^ expectedBytes.byteLength;
  for (let index = 0; index < Math.min(actual.length, expectedBytes.length); index++) mismatch |= actual[index]! ^ expectedBytes[index]!;
  if (mismatch !== 0) fail(code, "BCLIF checksum verification failed.");
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("BCLIF_HEADER_ENCODING", "BCLIF metadata is not canonical UTF-8.");
  }
}

function checkedCells(columns: number, rows: number) {
  const cells = columns * rows;
  if (!Number.isSafeInteger(cells) || cells < 1 || cells > MAX_CELLS) {
    fail("BCLIF_GRID_BOUND", "BCLIF tile grid exceeds the client safety bound.");
  }
  return cells;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("BCLIF_HEADER_FIELD", `BCLIF ${name} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) fail("BCLIF_HEADER_FIELD", `BCLIF ${name} is invalid.`);
  return value.trim();
}

function finite(value: unknown, name: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) fail("BCLIF_HEADER_FIELD", `BCLIF ${name} is not finite.`);
  return numeric;
}

function integer(value: unknown, name: string) {
  const numeric = finite(value, name);
  if (!Number.isSafeInteger(numeric)) fail("BCLIF_HEADER_FIELD", `BCLIF ${name} is not an integer.`);
  return numeric;
}

function positiveScale(value: unknown, name: string) {
  const numeric = finite(value, name);
  if (numeric <= 0 || numeric > Number.MAX_VALUE / 4) fail("BCLIF_HEADER_FIELD", `BCLIF ${name} scale is invalid.`);
  return numeric;
}

function integerInRange(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("BCLIF_HEADER_BOUND", `BCLIF ${name} is outside the supported range.`);
  }
}

function equal(actual: string | number, expected: string | number, name: string) {
  if (actual !== expected) fail("BCLIF_MANIFEST_MISMATCH", `BCLIF ${name} differs from its protected manifest.`);
}

function close(actual: number, expected: number, name: string, absoluteTolerance = Math.max(1e-9, Math.abs(expected) * 1e-9)) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > absoluteTolerance) {
    fail("BCLIF_MANIFEST_MISMATCH", `BCLIF ${name} differs from its protected manifest.`);
  }
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function ownedArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("BCLIF_HEADER_CANONICAL", "BCLIF metadata contains a non-finite number.");
      return item;
    }
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        result[key] = normalize((item as Record<string, unknown>)[key]);
      }
      return result;
    }
    fail("BCLIF_HEADER_CANONICAL", "BCLIF metadata contains an unsupported JSON value.");
  };
  return JSON.stringify(normalize(value));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function fail(code: string, message: string): never {
  throw new LiquidationFieldTileContractError(code, message);
}
