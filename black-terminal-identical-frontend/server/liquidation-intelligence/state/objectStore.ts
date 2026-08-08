import { createHash } from "node:crypto";
import { BCLIF_OBJECT_BUCKET } from "../contracts.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TILE_PATH = new RegExp(`^v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(6H|12H|1D|3D|1W|3W|1M|CUSTOM)/[0-9]{10,16}/${UUID}-[0-9a-f]{64}\\.bclif$`);
const EVENT_PATH = new RegExp(`^events/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(TRADE|LIQUIDATION|OPEN_INTEREST|BOOK_FRAME|FUNDING|MARK_INDEX|POSITION_RATIO|RISK_TIER|INSTRUMENT_INFO)/[0-9]{10,16}/${UUID}-[0-9a-f]{64}\\.events\\.gz$`);
const CHECKPOINT_PATH = new RegExp(`^checkpoints/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/[0-9]{10,16}/${UUID}-[0-9a-f]{64}\\.checkpoint\\.gz$`);

export type BclifObjectKind = "tile" | "event" | "checkpoint";

export function validateBclifObjectPath(path: string, kind: BclifObjectKind) {
  const matcher = kind === "tile" ? TILE_PATH : kind === "event" ? EVENT_PATH : CHECKPOINT_PATH;
  if (!matcher.test(path) || path.includes("..") || path.startsWith("/")) throw new Error(`Invalid BCLIF ${kind} object path`);
  return path;
}

export function objectSha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class BclifObjectStore {
  private readonly supabase: any;
  private readonly bucket: string;
  constructor(supabase: any, bucket = BCLIF_OBJECT_BUCKET) {
    this.supabase = supabase;
    this.bucket = bucket;
    if (!supabase) throw new Error("BCLIF object store requires a Supabase admin client");
    if (bucket !== BCLIF_OBJECT_BUCKET) throw new Error("Unexpected BCLIF object bucket");
  }

  async verifyAvailable() {
    const probe = await this.supabase.storage.from(this.bucket).list("", { limit: 1 });
    if (probe.error) throw probe.error;
    return true;
  }

  async upload(path: string, bytes: Uint8Array, kind: BclifObjectKind, contentType = "application/octet-stream") {
    validateBclifObjectPath(path, kind);
    if (!bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) throw new Error("BCLIF object size is outside storage bounds");
    const result = await this.supabase.storage.from(this.bucket).upload(path, bytes, {
      contentType,
      cacheControl: "31536000, immutable",
      upsert: false
    });
    if (result.error) throw result.error;
    const downloaded = await this.download(path, kind);
    const expected = objectSha256(bytes);
    const actual = objectSha256(downloaded);
    if (actual !== expected) {
      await this.remove(path, kind).catch(() => null);
      throw new Error("BCLIF object read-back checksum mismatch");
    }
    return { path, checksum: expected, bytes: bytes.byteLength };
  }

  async download(path: string, kind: BclifObjectKind) {
    validateBclifObjectPath(path, kind);
    const result = await this.supabase.storage.from(this.bucket).download(path);
    if (result.error) throw result.error;
    if (!result.data) throw new Error("BCLIF object download returned no data");
    const bytes = new Uint8Array(await result.data.arrayBuffer());
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("BCLIF object exceeds download safety bound");
    return bytes;
  }

  async remove(path: string, kind: BclifObjectKind) {
    validateBclifObjectPath(path, kind);
    const result = await this.supabase.storage.from(this.bucket).remove([path]);
    if (result.error) throw result.error;
  }
}
