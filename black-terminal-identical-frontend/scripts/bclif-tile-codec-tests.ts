import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { BCLIF_TILE_SCHEMA_VERSION } from "../server/liquidation-intelligence/contracts.ts";
import { canonicalJson } from "../server/liquidation-intelligence/normalization/canonicalEnvelope.ts";
import {
  BCLIF_FIXED_HEADER_BYTES,
  BCLIF_MAGIC,
  decodeBclifTile,
  encodeBclifTile
} from "../server/liquidation-intelligence/tiles/tileCodec.ts";
import { assertFloatArrayClose, makeTile } from "./bclif-test-fixtures.ts";

const tile = makeTile(32, 64);
const first = encodeBclifTile(tile);
const second = encodeBclifTile(tile);
assert.deepEqual(first.bytes, second.bytes, "codec output must be byte-deterministic for retry-safe object identity");
assert.equal(Buffer.from(first.bytes).subarray(0, 4).toString("ascii"), BCLIF_MAGIC);
assert.equal(first.header.schemaVersion, BCLIF_TILE_SCHEMA_VERSION);
assert.deepEqual(first.header.channelOrder, [
  "timestamps", "longExposure", "shortExposure", "combinedExposure", "confidence", "validity", "confirmedIntensity",
  "causalNormalizationLow", "causalNormalizationHigh", "longExposureScale", "shortExposureScale", "combinedExposureScale",
  "confirmedNotional", "confirmedCount"
], "persistent v2 tiles must carry the complete fourteen-channel manifest");

const decoded = decodeBclifTile(first.bytes);
assert.equal(decoded.tileId, tile.tileId);
assert.equal(decoded.columns, tile.columns);
assert.equal(decoded.rows, tile.rows);
assert.deepEqual(decoded.channels.timestamps, tile.channels.timestamps);
assert.deepEqual(decoded.channels.confidence, tile.channels.confidence);
assert.deepEqual(decoded.channels.validity, tile.channels.validity);
assert.deepEqual(decoded.channels.confirmedIntensity, tile.channels.confirmedIntensity);
assert.deepEqual(decoded.channels.confirmedCount, tile.channels.confirmedCount);
assertFloatArrayClose(decoded.channels.longExposure, tile.channels.longExposure);
assertFloatArrayClose(decoded.channels.shortExposure, tile.channels.shortExposure);
assertFloatArrayClose(decoded.channels.combinedExposure, tile.channels.combinedExposure);
assertFloatArrayClose(decoded.channels.confirmedNotional, tile.channels.confirmedNotional, 1e-6);
assertFloatArrayClose(decoded.channels.causalNormalizationLow, tile.channels.causalNormalizationLow, 1e-6);
assertFloatArrayClose(decoded.channels.causalNormalizationHigh, tile.channels.causalNormalizationHigh, 1e-6);

assert.throws(() => decodeBclifTile(first.bytes.slice(0, BCLIF_FIXED_HEADER_BYTES - 1)), /Truncated/);
const wrongMagic = Uint8Array.from(first.bytes);
wrongMagic[0] = 0;
assert.throws(() => decodeBclifTile(wrongMagic), /magic/);
const trailing = new Uint8Array(first.bytes.length + 1);
trailing.set(first.bytes);
assert.throws(() => decodeBclifTile(trailing), /truncated or has trailing bytes/);
const corruptPayload = Uint8Array.from(first.bytes);
corruptPayload[corruptPayload.length - 5] = corruptPayload[corruptPayload.length - 5]! ^ 0xff;
assert.throws(() => decodeBclifTile(corruptPayload));

const inconsistentGrid = mutateHeader(first.bytes, (header) => { header.startTime += 1; });
assert.throws(() => decodeBclifTile(inconsistentGrid), /time grid|timestamps/);

const invalidValidity = mutatePayload(first.bytes, (payload, header) => {
  const cells = Number(header.columns) * Number(header.rows);
  const validityOffset = Number(header.columns) * 8 + cells * 2 * 3 + cells;
  payload[validityOffset] = 2;
});
assert.throws(() => decodeBclifTile(invalidValidity), /validity must be binary/);

const invalid = makeTile(2, 4);
invalid.channels.confirmedCount[0] = 1;
invalid.channels.confirmedNotional[0] = 0;
assert.throws(() => encodeBclifTile(invalid), /count\/notional/);

console.log(JSON.stringify({
  decision: "PASS",
  schemaVersion: BCLIF_TILE_SCHEMA_VERSION,
  channels: first.header.channelOrder.length,
  compressedBytes: first.bytes.byteLength,
  objectChecksum: first.objectChecksum
}, null, 2));

function mutateHeader(input: Uint8Array, mutate: (header: any) => void) {
  const bytes = Buffer.from(input);
  const headerLength = bytes.readUInt32LE(8);
  const header = JSON.parse(bytes.toString("utf8", BCLIF_FIXED_HEADER_BYTES, BCLIF_FIXED_HEADER_BYTES + headerLength));
  mutate(header);
  const encoded = Buffer.from(canonicalJson(header), "utf8");
  assert.equal(encoded.byteLength, headerLength, "header mutation fixture must preserve the fixed header length");
  const output = Buffer.from(bytes);
  encoded.copy(output, BCLIF_FIXED_HEADER_BYTES);
  return output;
}

function mutatePayload(input: Uint8Array, mutate: (payload: Buffer, header: any) => void) {
  const bytes = Buffer.from(input);
  const headerLength = bytes.readUInt32LE(8);
  const headerBytes = bytes.subarray(BCLIF_FIXED_HEADER_BYTES, BCLIF_FIXED_HEADER_BYTES + headerLength);
  const header = JSON.parse(headerBytes.toString("utf8"));
  const payload = Buffer.from(gunzipSync(bytes.subarray(BCLIF_FIXED_HEADER_BYTES + headerLength)));
  mutate(payload, header);
  const compressed = gzipSync(payload, { level: 9, mtime: 0 } as any);
  const fixed = Buffer.from(bytes.subarray(0, BCLIF_FIXED_HEADER_BYTES));
  fixed.writeUInt32LE(compressed.byteLength, 12);
  fixed.writeUInt32LE(payload.byteLength, 16);
  createHash("sha256").update(payload).digest().copy(fixed, 20);
  return Buffer.concat([fixed, headerBytes, compressed]);
}
