import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  BCLIF_TILE_SCHEMA_VERSION,
  type BclifDecodedTile,
  type BclifTileChannels,
  type BclifTileInput
} from "../contracts.ts";
import { canonicalJson } from "../normalization/canonicalEnvelope.ts";

export const BCLIF_MAGIC = "BCLF" as const;
export const BCLIF_FIXED_HEADER_BYTES = 52;
export const BCLIF_FLAG_GZIP = 1;
export const BCLIF_MAX_HEADER_BYTES = 64 * 1024;
export const BCLIF_MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
export const BCLIF_MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
export const BCLIF_MAX_COLUMNS = 4_096;
export const BCLIF_MAX_ROWS = 1_024;
export const BCLIF_MAX_CELLS = 8_388_608;
const BCLIF_SUPPORTED_HORIZONS = new Set(["6H", "12H", "1D", "3D", "1W", "3W", "1M", "CUSTOM"]);

export const BCLIF_REQUIRED_CHANNEL_ORDER = [
  "timestamps",
  "longExposure",
  "shortExposure",
  "combinedExposure",
  "confidence",
  "validity",
  "confirmedIntensity"
] as const;

export const BCLIF_OPTIONAL_CHANNEL_ORDER = ["causalNormalizationLow", "causalNormalizationHigh"] as const;
export const BCLIF_COLUMN_SCALE_CHANNEL_ORDER = ["longExposureScale", "shortExposureScale", "combinedExposureScale"] as const;
export const BCLIF_CONFIRMED_QUANTITATIVE_CHANNEL_ORDER = ["confirmedNotional", "confirmedCount"] as const;

export type BclifChannelName =
  | (typeof BCLIF_REQUIRED_CHANNEL_ORDER)[number]
  | (typeof BCLIF_OPTIONAL_CHANNEL_ORDER)[number]
  | (typeof BCLIF_COLUMN_SCALE_CHANNEL_ORDER)[number]
  | (typeof BCLIF_CONFIRMED_QUANTITATIVE_CHANNEL_ORDER)[number];

export interface BclifChannelDescriptor {
  name: BclifChannelName;
  storage: "FLOAT64_LE" | "FLOAT32_LE" | "UINT16_LE" | "UINT8";
  count: number;
  byteOffset: number;
  byteLength: number;
}

export interface BclifTileHeaderV2 {
  authority: BclifTileInput["authority"];
  channelOrder: BclifChannelName[];
  columns: number;
  endTime: number;
  horizon: BclifTileInput["horizon"];
  marketKind: "linear_perpetual";
  maxPrice: number;
  minPrice: number;
  modelVersion: string;
  priceStep: number;
  rows: number;
  scales: {
    combinedExposure: number;
    longExposure: number;
    shortExposure: number;
  };
  schemaVersion: typeof BCLIF_TILE_SCHEMA_VERSION;
  sourceCutoffTimestamp: number;
  sourceVersion: string;
  startTime: number;
  symbol: string;
  tileId: string;
  tileVersion: number;
  timeStepMs: number;
  venue: "BYBIT";
}

export interface EncodedBclifTile {
  bytes: Uint8Array;
  header: BclifTileHeaderV2;
  objectChecksum: string;
  payloadChecksum: string;
}

export function encodeBclifTile(input: BclifTileInput): EncodedBclifTile {
  validateTileInput(input);
  const cells = input.columns * input.rows;
  const longMaximum = Math.max(1, finiteMaximum(input.channels.longExposure));
  const shortMaximum = Math.max(1, finiteMaximum(input.channels.shortExposure));
  const combinedMaximum = Math.max(1, finiteMaximum(input.channels.combinedExposure));
  const includeNormalization = input.channels.causalNormalizationLow.length > 0 || input.channels.causalNormalizationHigh.length > 0;
  if (!includeNormalization) {
    throw new Error("BCLIF schema-v2 tile encoding requires causal normalization bounds");
  }
  if (includeNormalization && (
    input.channels.causalNormalizationLow.length !== input.columns ||
    input.channels.causalNormalizationHigh.length !== input.columns
  )) throw new Error("BCLIF normalization channels must both contain one value per column");
  const longScales = causalColumnScales(input.channels.longExposure, input.columns, input.rows, input.channels.longExposureScale);
  const shortScales = causalColumnScales(input.channels.shortExposure, input.columns, input.rows, input.channels.shortExposureScale);
  const combinedScales = causalColumnScales(input.channels.combinedExposure, input.columns, input.rows, input.channels.combinedExposureScale);

  const channelParts: Buffer[] = [];
  const channels: BclifChannelDescriptor[] = [];
  let byteOffset = 0;
  const append = (name: BclifChannelName, storage: BclifChannelDescriptor["storage"], bytes: Buffer, count: number) => {
    channels.push({ name, storage, count, byteOffset, byteLength: bytes.byteLength });
    channelParts.push(bytes);
    byteOffset += bytes.byteLength;
  };

  append("timestamps", "FLOAT64_LE", encodeFloat64(input.channels.timestamps), input.columns);
  append("longExposure", "UINT16_LE", encodeLogUint16ByColumn(input.channels.longExposure, input.rows, longScales), cells);
  append("shortExposure", "UINT16_LE", encodeLogUint16ByColumn(input.channels.shortExposure, input.rows, shortScales), cells);
  append("combinedExposure", "UINT16_LE", encodeLogUint16ByColumn(input.channels.combinedExposure, input.rows, combinedScales), cells);
  append("confidence", "UINT8", copyBytes(input.channels.confidence), cells);
  append("validity", "UINT8", copyBytes(input.channels.validity), cells);
  append("confirmedIntensity", "UINT8", copyBytes(input.channels.confirmedIntensity), cells);
  if (includeNormalization) {
    append("causalNormalizationLow", "FLOAT32_LE", encodeFloat32(input.channels.causalNormalizationLow), input.columns);
    append("causalNormalizationHigh", "FLOAT32_LE", encodeFloat32(input.channels.causalNormalizationHigh), input.columns);
  }
  append("longExposureScale", "FLOAT32_LE", encodeFloat32(longScales), input.columns);
  append("shortExposureScale", "FLOAT32_LE", encodeFloat32(shortScales), input.columns);
  append("combinedExposureScale", "FLOAT32_LE", encodeFloat32(combinedScales), input.columns);
  append("confirmedNotional", "FLOAT32_LE", encodeFloat32(input.channels.confirmedNotional), cells);
  append("confirmedCount", "UINT16_LE", encodeUint16(input.channels.confirmedCount), cells);

  const payload = Buffer.concat(channelParts);
  const payloadHash = createHash("sha256").update(payload).digest();
  const scales: BclifTileHeaderV2["scales"] = {
    combinedExposure: combinedMaximum,
    longExposure: longMaximum,
    shortExposure: shortMaximum
  };
  const header: BclifTileHeaderV2 = {
    authority: input.authority,
    channelOrder: channels.map((channel) => channel.name),
    columns: input.columns,
    endTime: input.endTime,
    horizon: input.horizon,
    marketKind: input.marketKind,
    maxPrice: input.maxPrice,
    minPrice: input.minPrice,
    modelVersion: input.modelVersion,
    priceStep: input.priceStep,
    rows: input.rows,
    scales,
    schemaVersion: BCLIF_TILE_SCHEMA_VERSION,
    sourceCutoffTimestamp: input.sourceCutoffTimestamp,
    sourceVersion: input.sourceVersion,
    startTime: input.startTime,
    symbol: input.symbol,
    tileId: input.tileId,
    tileVersion: input.tileVersion ?? 1,
    timeStepMs: input.timeStepMs,
    venue: input.venue
  };
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  if (headerBytes.byteLength > BCLIF_MAX_HEADER_BYTES) throw new Error("BCLIF tile header is too large");
  const compressed = gzipSync(payload, { level: 9, mtime: 0 } as any);
  if (compressed.byteLength > BCLIF_MAX_COMPRESSED_BYTES) throw new Error("BCLIF compressed payload is too large");
  const fixed = Buffer.alloc(BCLIF_FIXED_HEADER_BYTES);
  fixed.write(BCLIF_MAGIC, 0, "ascii");
  fixed.writeUInt16LE(BCLIF_TILE_SCHEMA_VERSION, 4);
  fixed.writeUInt16LE(BCLIF_FLAG_GZIP, 6);
  fixed.writeUInt32LE(headerBytes.byteLength, 8);
  fixed.writeUInt32LE(compressed.byteLength, 12);
  fixed.writeUInt32LE(payload.byteLength, 16);
  payloadHash.copy(fixed, 20);
  const bytes = Buffer.concat([fixed, headerBytes, compressed]);
  return {
    bytes,
    header,
    objectChecksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    payloadChecksum: `sha256:${payloadHash.toString("hex")}`
  };
}

export function decodeBclifTile(input: Uint8Array): BclifDecodedTile {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < BCLIF_FIXED_HEADER_BYTES) throw new Error("Truncated BCLIF fixed header");
  if (bytes.toString("ascii", 0, 4) !== BCLIF_MAGIC) throw new Error("Invalid BCLIF magic");
  const schemaVersion = bytes.readUInt16LE(4);
  if (schemaVersion !== BCLIF_TILE_SCHEMA_VERSION) throw new Error(`Unsupported BCLIF schema ${schemaVersion}`);
  const flags = bytes.readUInt16LE(6);
  if (flags !== BCLIF_FLAG_GZIP) throw new Error(`Unsupported BCLIF flags ${flags}`);
  const headerLength = bytes.readUInt32LE(8);
  const compressedLength = bytes.readUInt32LE(12);
  const uncompressedLength = bytes.readUInt32LE(16);
  if (!headerLength || headerLength > BCLIF_MAX_HEADER_BYTES) throw new Error("Invalid BCLIF JSON header length");
  if (!compressedLength || compressedLength > BCLIF_MAX_COMPRESSED_BYTES) throw new Error("Invalid BCLIF compressed length");
  if (!uncompressedLength || uncompressedLength > BCLIF_MAX_UNCOMPRESSED_BYTES) throw new Error("Invalid BCLIF payload length");
  const expectedLength = BCLIF_FIXED_HEADER_BYTES + headerLength + compressedLength;
  if (bytes.byteLength !== expectedLength) throw new Error("BCLIF object is truncated or has trailing bytes");
  let header: BclifTileHeaderV2;
  const headerText = bytes.toString("utf8", BCLIF_FIXED_HEADER_BYTES, BCLIF_FIXED_HEADER_BYTES + headerLength);
  try {
    header = JSON.parse(headerText);
  } catch {
    throw new Error("Invalid BCLIF JSON header");
  }
  if (canonicalJson(header) !== headerText) throw new Error("BCLIF JSON header is not canonical");
  validateTileHeader(header, uncompressedLength);
  const payload = gunzipSync(bytes.subarray(BCLIF_FIXED_HEADER_BYTES + headerLength), {
    maxOutputLength: BCLIF_MAX_UNCOMPRESSED_BYTES
  });
  if (payload.byteLength !== uncompressedLength) throw new Error("BCLIF uncompressed length mismatch");
  const expectedPayloadHash = bytes.subarray(20, 52);
  const actualPayloadHash = createHash("sha256").update(payload).digest();
  if (!actualPayloadHash.equals(expectedPayloadHash)) throw new Error("BCLIF payload checksum mismatch");
  const decoded = decodeChannels(header, payload);
  validateDecodedChannels(header, decoded);
  return {
    tileId: header.tileId,
    tileVersion: header.tileVersion,
    venue: header.venue,
    symbol: header.symbol,
    marketKind: header.marketKind,
    horizon: header.horizon,
    authority: header.authority,
    modelVersion: header.modelVersion,
    sourceVersion: header.sourceVersion,
    coverageQuality: "INSUFFICIENT",
    startTime: header.startTime,
    endTime: header.endTime,
    sourceCutoffTimestamp: header.sourceCutoffTimestamp,
    minPrice: header.minPrice,
    maxPrice: header.maxPrice,
    timeStepMs: header.timeStepMs,
    priceStep: header.priceStep,
    columns: header.columns,
    rows: header.rows,
    createdAt: header.sourceCutoffTimestamp,
    channels: decoded,
    schemaVersion: BCLIF_TILE_SCHEMA_VERSION,
    payloadChecksum: `sha256:${actualPayloadHash.toString("hex")}`
  };
}

export function decodeLogUint16(value: number, maximum: number) {
  if (!Number.isFinite(maximum) || maximum < 0) throw new Error("Invalid BCLIF log scale maximum");
  return Math.expm1((value / 65_535) * Math.log1p(maximum));
}

function decodeChannels(header: BclifTileHeaderV2, payload: Buffer): BclifTileChannels {
  const descriptors = channelDescriptors(header.channelOrder, header.columns, header.rows);
  const byName = new Map(descriptors.map((channel) => [channel.name, channel]));
  const cells = header.columns * header.rows;
  const required = <T extends BclifChannelName>(name: T) => {
    const descriptor = byName.get(name);
    if (!descriptor) throw new Error(`Missing BCLIF channel ${name}`);
    return descriptor;
  };
  const slice = (descriptor: BclifChannelDescriptor) => payload.subarray(descriptor.byteOffset, descriptor.byteOffset + descriptor.byteLength);
  const timestamps = decodeFloat64(slice(required("timestamps")), header.columns);
  const longScaleDescriptor = byName.get("longExposureScale");
  const shortScaleDescriptor = byName.get("shortExposureScale");
  const combinedScaleDescriptor = byName.get("combinedExposureScale");
  const hasColumnScales = Boolean(longScaleDescriptor && shortScaleDescriptor && combinedScaleDescriptor);
  const longScales = longScaleDescriptor ? decodeFloat32(slice(longScaleDescriptor), header.columns) : null;
  const shortScales = shortScaleDescriptor ? decodeFloat32(slice(shortScaleDescriptor), header.columns) : null;
  const combinedScales = combinedScaleDescriptor ? decodeFloat32(slice(combinedScaleDescriptor), header.columns) : null;
  const longExposure = hasColumnScales
    ? decodeLogArrayByColumn(slice(required("longExposure")), header.columns, header.rows, longScales!)
    : decodeLogArray(slice(required("longExposure")), cells, header.scales.longExposure);
  const shortExposure = hasColumnScales
    ? decodeLogArrayByColumn(slice(required("shortExposure")), header.columns, header.rows, shortScales!)
    : decodeLogArray(slice(required("shortExposure")), cells, header.scales.shortExposure);
  const combinedExposure = hasColumnScales
    ? decodeLogArrayByColumn(slice(required("combinedExposure")), header.columns, header.rows, combinedScales!)
    : decodeLogArray(slice(required("combinedExposure")), cells, header.scales.combinedExposure);
  const confidence = Uint8Array.from(slice(required("confidence")));
  const validity = Uint8Array.from(slice(required("validity")));
  const confirmedIntensity = Uint8Array.from(slice(required("confirmedIntensity")));
  const confirmedNotional = decodeFloat32(slice(required("confirmedNotional")), cells);
  const confirmedCount = decodeUint16(slice(required("confirmedCount")), cells);
  const low = byName.get("causalNormalizationLow");
  const high = byName.get("causalNormalizationHigh");
  return {
    timestamps,
    longExposure,
    shortExposure,
    combinedExposure,
    confidence,
    validity,
    confirmedIntensity,
    confirmedNotional,
    confirmedCount,
    causalNormalizationLow: low ? decodeFloat32(slice(low), header.columns) : new Float32Array(),
    causalNormalizationHigh: high ? decodeFloat32(slice(high), header.columns) : new Float32Array(),
    longExposureScale: longScales ?? undefined,
    shortExposureScale: shortScales ?? undefined,
    combinedExposureScale: combinedScales ?? undefined
  };
}

function validateTileInput(input: BclifTileInput) {
  if (!isUuid(input.tileId)) throw new Error("BCLIF tileId must be a UUID");
  const tileVersion = input.tileVersion ?? 1;
  if (tileVersion !== 1) throw new Error("Invalid BCLIF tile version");
  if (input.venue !== "BYBIT" || input.marketKind !== "linear_perpetual") throw new Error("Unsupported BCLIF market identity");
  if (!/^[A-Z0-9_-]{2,40}$/.test(input.symbol)) throw new Error("Invalid BCLIF symbol");
  if (!Number.isSafeInteger(input.columns) || input.columns < 1 || input.columns > BCLIF_MAX_COLUMNS) throw new Error("Invalid BCLIF column count");
  if (!Number.isSafeInteger(input.rows) || input.rows < 1 || input.rows > BCLIF_MAX_ROWS) throw new Error("Invalid BCLIF row count");
  const cells = input.columns * input.rows;
  if (!Number.isSafeInteger(cells) || cells > BCLIF_MAX_CELLS) throw new Error("BCLIF tile grid exceeds the codec cell bound");
  requireLength(input.channels.timestamps, input.columns, "timestamps");
  requireLength(input.channels.longExposure, cells, "longExposure");
  requireLength(input.channels.shortExposure, cells, "shortExposure");
  requireLength(input.channels.combinedExposure, cells, "combinedExposure");
  requireLength(input.channels.confidence, cells, "confidence");
  requireLength(input.channels.validity, cells, "validity");
  requireLength(input.channels.confirmedIntensity, cells, "confirmedIntensity");
  requireLength(input.channels.confirmedNotional, cells, "confirmedNotional");
  requireLength(input.channels.confirmedCount, cells, "confirmedCount");
  const hasLow = input.channels.causalNormalizationLow.length > 0;
  const hasHigh = input.channels.causalNormalizationHigh.length > 0;
  if (hasLow !== hasHigh) throw new Error("BCLIF causal normalization channels must be paired");
  if (!hasLow || !hasHigh) {
    throw new Error("BCLIF schema-v2 tile encoding requires causal normalization bounds");
  }
  if (hasLow) {
    requireLength(input.channels.causalNormalizationLow, input.columns, "causalNormalizationLow");
    requireLength(input.channels.causalNormalizationHigh, input.columns, "causalNormalizationHigh");
    for (let index = 0; index < input.columns; index += 1) {
      const low = input.channels.causalNormalizationLow[index]!;
      const high = input.channels.causalNormalizationHigh[index]!;
      if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) throw new Error("Invalid BCLIF causal normalization bounds");
    }
  }
  if (!(input.endTime > input.startTime) || input.sourceCutoffTimestamp < input.endTime || input.sourceCutoffTimestamp > input.createdAt + 3_000) throw new Error("Invalid BCLIF time bounds");
  if (!(input.maxPrice > input.minPrice) || !(input.timeStepMs > 0) || !(input.priceStep > 0)) throw new Error("Invalid BCLIF grid bounds");
  if (!approximatelyEqual(input.maxPrice, input.minPrice + Math.max(1, input.rows - 1) * input.priceStep)) throw new Error("BCLIF input price grid is inconsistent");
  for (let index = 0; index < input.channels.timestamps.length; index += 1) {
    const expected = input.startTime + index * input.timeStepMs;
    if (input.channels.timestamps[index] !== expected) throw new Error("BCLIF timestamps do not match the declared fixed grid");
  }
  if (input.channels.timestamps.at(-1) !== input.endTime) throw new Error("BCLIF endTime must equal the final timestamp");
  validateFiniteNonNegative(input.channels.longExposure, "longExposure");
  validateFiniteNonNegative(input.channels.shortExposure, "shortExposure");
  validateFiniteNonNegative(input.channels.combinedExposure, "combinedExposure");
  validateFiniteNonNegative(input.channels.confirmedNotional, "confirmedNotional");
  for (let index = 0; index < cells; index += 1) {
    const count = input.channels.confirmedCount[index]!;
    if (!Number.isSafeInteger(count) || count < 0 || count > 65_535) throw new Error("Invalid BCLIF confirmedCount");
    if ((count === 0) !== (input.channels.confirmedNotional[index] === 0)) throw new Error("BCLIF confirmed count/notional channels disagree");
  }
  for (const value of input.channels.validity) if (value !== 0 && value !== 1) throw new Error("BCLIF validity must be binary");
}

function validateTileHeader(header: BclifTileHeaderV2, uncompressedLength: number) {
  if (!header || header.schemaVersion !== BCLIF_TILE_SCHEMA_VERSION || header.tileVersion !== 1) throw new Error("Invalid BCLIF tile header version");
  if (!isUuid(header.tileId)) throw new Error("Invalid BCLIF tile header identity");
  if (header.venue !== "BYBIT" || header.marketKind !== "linear_perpetual" || !/^[A-Z0-9_-]{2,40}$/.test(header.symbol)) throw new Error("Invalid BCLIF tile market identity");
  if (!BCLIF_SUPPORTED_HORIZONS.has(header.horizon) || typeof header.modelVersion !== "string" || !header.modelVersion.trim() || typeof header.sourceVersion !== "string" || !header.sourceVersion.trim()) {
    throw new Error("Invalid BCLIF tile generation identity");
  }
  if (!Number.isSafeInteger(header.columns) || header.columns < 1 || header.columns > BCLIF_MAX_COLUMNS) throw new Error("Invalid BCLIF header columns");
  if (!Number.isSafeInteger(header.rows) || header.rows < 1 || header.rows > BCLIF_MAX_ROWS) throw new Error("Invalid BCLIF header rows");
  if (!Number.isSafeInteger(header.columns * header.rows) || header.columns * header.rows > BCLIF_MAX_CELLS) throw new Error("BCLIF header grid exceeds the codec cell bound");
  if (header.authority !== "PERSISTENT_NODE" && header.authority !== "REPLAY" && header.authority !== "TEST_FIXTURE") throw new Error("Invalid BCLIF model authority");
  if (
    !Number.isSafeInteger(header.startTime)
    || !Number.isSafeInteger(header.endTime)
    || !Number.isSafeInteger(header.sourceCutoffTimestamp)
    || !Number.isSafeInteger(header.timeStepMs)
    || !Number.isFinite(header.minPrice)
    || !Number.isFinite(header.maxPrice)
    || !Number.isFinite(header.priceStep)
    || header.startTime >= header.endTime
    || header.minPrice >= header.maxPrice
    || header.timeStepMs <= 0
    || header.priceStep <= 0
  ) throw new Error("Invalid BCLIF header bounds");
  if (header.endTime !== header.startTime + (header.columns - 1) * header.timeStepMs) throw new Error("BCLIF header time grid is inconsistent");
  const expectedMaxPrice = header.minPrice + Math.max(1, header.rows - 1) * header.priceStep;
  if (!approximatelyEqual(header.maxPrice, expectedMaxPrice)) throw new Error("BCLIF header price grid is inconsistent");
  if (header.sourceCutoffTimestamp < header.endTime) throw new Error("BCLIF source cutoff precedes the finalized tile boundary");
  const names = header.channelOrder;
  if (!Array.isArray(names)) throw new Error("Invalid BCLIF channel order");
  const required = [...BCLIF_REQUIRED_CHANNEL_ORDER];
  const persistentOrder = [...required, ...BCLIF_OPTIONAL_CHANNEL_ORDER, ...BCLIF_COLUMN_SCALE_CHANNEL_ORDER, ...BCLIF_CONFIRMED_QUANTITATIVE_CHANNEL_ORDER];
  if (names.length !== persistentOrder.length || names.some((name, index) => name !== persistentOrder[index])) throw new Error("Invalid BCLIF channel order");
  let expectedOffset = 0;
  const cells = header.columns * header.rows;
  for (const descriptor of channelDescriptors(header.channelOrder, header.columns, header.rows)) {
    const expected = expectedChannelShape(descriptor.name, header.columns, cells);
    if (descriptor.storage !== expected.storage || descriptor.count !== expected.count || descriptor.byteLength !== expected.byteLength || descriptor.byteOffset !== expectedOffset) {
      throw new Error(`Invalid BCLIF channel layout for ${descriptor.name}`);
    }
    expectedOffset += descriptor.byteLength;
  }
  if (expectedOffset !== uncompressedLength) throw new Error("BCLIF channel layout does not cover the payload exactly");
  validateLogScale(header.scales.longExposure);
  validateLogScale(header.scales.shortExposure);
  validateLogScale(header.scales.combinedExposure);
}

function validateDecodedChannels(header: BclifTileHeaderV2, channels: BclifTileChannels) {
  const cells = header.columns * header.rows;
  for (let column = 0; column < header.columns; column += 1) {
    const expectedTimestamp = header.startTime + column * header.timeStepMs;
    if (!Number.isFinite(channels.timestamps[column]) || channels.timestamps[column] !== expectedTimestamp) {
      throw new Error("Decoded BCLIF timestamps do not match the declared fixed grid");
    }
  }
  validateFiniteNonNegative(channels.longExposure, "decoded longExposure");
  validateFiniteNonNegative(channels.shortExposure, "decoded shortExposure");
  validateFiniteNonNegative(channels.combinedExposure, "decoded combinedExposure");
  validateFiniteNonNegative(channels.confirmedNotional, "decoded confirmedNotional");
  for (const value of channels.validity) if (value !== 0 && value !== 1) throw new Error("Decoded BCLIF validity must be binary");
  for (let index = 0; index < cells; index += 1) {
    const count = channels.confirmedCount[index]!;
    const notional = channels.confirmedNotional[index]!;
    if ((count === 0) !== (notional === 0)) throw new Error("Decoded BCLIF confirmed count/notional channels disagree");
  }
  const hasNormalization = channels.causalNormalizationLow.length > 0 || channels.causalNormalizationHigh.length > 0;
  if (hasNormalization) {
    requireLength(channels.causalNormalizationLow, header.columns, "decoded causalNormalizationLow");
    requireLength(channels.causalNormalizationHigh, header.columns, "decoded causalNormalizationHigh");
    for (let column = 0; column < header.columns; column += 1) {
      const low = channels.causalNormalizationLow[column]!;
      const high = channels.causalNormalizationHigh[column]!;
      if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) throw new Error("Invalid decoded BCLIF causal normalization bounds");
    }
  }
  const scaleSets = [
    [channels.longExposure, channels.longExposureScale, "long"],
    [channels.shortExposure, channels.shortExposureScale, "short"],
    [channels.combinedExposure, channels.combinedExposureScale, "combined"]
  ] as const;
  for (const [values, scales, name] of scaleSets) {
    if (!scales) continue;
    requireLength(scales, header.columns, `decoded ${name} exposure scale`);
    for (let column = 0; column < header.columns; column += 1) {
      const scale = scales[column]!;
      validateLogScale(scale);
      let maximum = 0;
      for (let row = 0; row < header.rows; row += 1) maximum = Math.max(maximum, values[column * header.rows + row]!);
      if (scale + Math.max(1e-5, Math.abs(scale) * 1e-5) < maximum) throw new Error(`Decoded BCLIF ${name} exposure exceeds its causal scale`);
    }
  }
}

function expectedChannelShape(name: BclifChannelName, columns: number, cells: number) {
  if (name === "timestamps") return { storage: "FLOAT64_LE" as const, count: columns, byteLength: columns * 8 };
  if (name === "causalNormalizationLow" || name === "causalNormalizationHigh" || BCLIF_COLUMN_SCALE_CHANNEL_ORDER.includes(name as any)) return { storage: "FLOAT32_LE" as const, count: columns, byteLength: columns * 4 };
  if (name === "confirmedNotional") return { storage: "FLOAT32_LE" as const, count: cells, byteLength: cells * 4 };
  if (name === "confirmedCount") return { storage: "UINT16_LE" as const, count: cells, byteLength: cells * 2 };
  if (name === "longExposure" || name === "shortExposure" || name === "combinedExposure") return { storage: "UINT16_LE" as const, count: cells, byteLength: cells * 2 };
  return { storage: "UINT8" as const, count: cells, byteLength: cells };
}

function channelDescriptors(order: BclifChannelName[], columns: number, rows: number) {
  const cells = columns * rows;
  let byteOffset = 0;
  return order.map((name): BclifChannelDescriptor => {
    const shape = expectedChannelShape(name, columns, cells);
    const descriptor = { name, ...shape, byteOffset };
    byteOffset += shape.byteLength;
    return descriptor;
  });
}

function encodeLogUint16(values: Float32Array, maximum: number) {
  const output = Buffer.alloc(values.length * 2);
  const denominator = Math.log1p(maximum);
  for (let index = 0; index < values.length; index += 1) {
    const encoded = denominator === 0 ? 0 : Math.round((Math.log1p(values[index]!) / denominator) * 65_535);
    output.writeUInt16LE(Math.max(0, Math.min(65_535, encoded)), index * 2);
  }
  return output;
}

function encodeLogUint16ByColumn(values: Float32Array, rows: number, scales: Float32Array) {
  const output = Buffer.alloc(values.length * 2);
  for (let column = 0; column < scales.length; column += 1) {
    const denominator = Math.log1p(scales[column]!);
    for (let row = 0; row < rows; row += 1) {
      const index = column * rows + row;
      const encoded = Math.round((Math.log1p(values[index]!) / denominator) * 65_535);
      output.writeUInt16LE(Math.max(0, Math.min(65_535, encoded)), index * 2);
    }
  }
  return output;
}

function decodeLogArray(bytes: Buffer, count: number, maximum: number) {
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) output[index] = decodeLogUint16(bytes.readUInt16LE(index * 2), maximum);
  return output;
}

function decodeLogArrayByColumn(bytes: Buffer, columns: number, rows: number, scales: Float32Array) {
  const output = new Float32Array(columns * rows);
  for (let column = 0; column < columns; column += 1) {
    const scale = scales[column]!;
    validateLogScale(scale);
    for (let row = 0; row < rows; row += 1) {
      const index = column * rows + row;
      output[index] = decodeLogUint16(bytes.readUInt16LE(index * 2), scale);
    }
  }
  return output;
}

function causalColumnScales(values: Float32Array, columns: number, rows: number, supplied?: Float32Array) {
  if (supplied) requireLength(supplied, columns, "column exposure scale");
  const scales = new Float32Array(columns);
  for (let column = 0; column < columns; column += 1) {
    let maximum = 1;
    for (let row = 0; row < rows; row += 1) maximum = Math.max(maximum, values[column * rows + row]!);
    const selected = supplied?.[column] ?? maximum;
    if (!Number.isFinite(selected) || selected <= 0 || selected + Math.max(1e-6, Math.abs(selected) * 1e-6) < maximum) {
      throw new Error("Invalid BCLIF causal column exposure scale");
    }
    scales[column] = selected;
  }
  return scales;
}

function encodeFloat64(values: Float64Array) {
  const output = Buffer.alloc(values.length * 8);
  for (let index = 0; index < values.length; index += 1) output.writeDoubleLE(values[index]!, index * 8);
  return output;
}

function decodeFloat64(bytes: Buffer, count: number) {
  const output = new Float64Array(count);
  for (let index = 0; index < count; index += 1) output[index] = bytes.readDoubleLE(index * 8);
  return output;
}

function encodeFloat32(values: Float32Array) {
  const output = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) output.writeFloatLE(values[index]!, index * 4);
  return output;
}

function decodeFloat32(bytes: Buffer, count: number) {
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) output[index] = bytes.readFloatLE(index * 4);
  return output;
}

function encodeUint16(values: Uint16Array) {
  const output = Buffer.alloc(values.length * 2);
  for (let index = 0; index < values.length; index += 1) output.writeUInt16LE(values[index]!, index * 2);
  return output;
}

function decodeUint16(bytes: Buffer, count: number) {
  if (bytes.byteLength !== count * 2) throw new Error("Invalid BCLIF Uint16 channel length");
  const output = new Uint16Array(count);
  for (let index = 0; index < count; index += 1) output[index] = bytes.readUInt16LE(index * 2);
  return output;
}

function copyBytes(values: Uint8Array) { return Buffer.from(values.buffer, values.byteOffset, values.byteLength); }
function finiteMaximum(values: Float32Array) { let max = 0; for (const value of values) if (value > max) max = value; return max; }
function validateLogScale(scale: number) { if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid BCLIF log scale metadata"); }
function requireLength(value: ArrayLike<number>, expected: number, name: string) { if (value.length !== expected) throw new Error(`BCLIF ${name} length must be ${expected}`); }
function validateFiniteNonNegative(values: Float32Array, name: string) { for (const value of values) if (!Number.isFinite(value) || value < 0) throw new Error(`BCLIF ${name} must contain finite non-negative values`); }
function approximatelyEqual(left: number, right: number) { return Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 1e-9); }
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
