import { gunzipSync, gzipSync } from "node:zlib";
import type { BclifCanonicalEvent, BclifCanonicalEventKind, BclifWriterFence } from "../contracts.ts";
import { canonicalJson } from "../normalization/canonicalEnvelope.ts";
import { BclifObjectStore, objectSha256 } from "./objectStore.ts";
import { deterministicBclifTileId } from "../tiles/tileBuilder.ts";
import { validateWriterFence, writerFenceColumns } from "./writerFence.ts";

const MAX_EVENT_CHUNK_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const STORED_EVENT_KINDS = new Set<BclifCanonicalEventKind>([
  "TRADE", "LIQUIDATION", "OPEN_INTEREST", "BOOK_FRAME", "FUNDING", "MARK_INDEX", "POSITION_RATIO", "RISK_TIER", "INSTRUMENT_INFO"
]);

export class BclifEventChunkRepository {
  private readonly supabase: any;
  private readonly objectStore: BclifObjectStore;
  private readonly sourceId: string;
  private readonly nodeId: string;
  private readonly sourceVersion: string;
  private readonly fence: BclifWriterFence;
  constructor(
    supabase: any,
    objectStore: BclifObjectStore,
    sourceId: string,
    nodeId: string,
    sourceVersion: string,
    fence: BclifWriterFence
  ) { this.supabase = supabase; this.objectStore = objectStore; this.sourceId = sourceId; this.nodeId = nodeId; this.sourceVersion = sourceVersion; this.fence = validateWriterFence(fence); }

  async publish(kind: BclifCanonicalEventKind, events: BclifCanonicalEvent[]) {
    if (!STORED_EVENT_KINDS.has(kind)) throw new Error(`BCLIF event kind ${kind} is not chunk-storable`);
    const selected = events
      .filter((event) => event.kind === kind)
      .sort(compareCanonicalEvents);
    if (!selected.length) throw new Error("Cannot publish an empty BCLIF event chunk");
    const raw = new TextEncoder().encode(`${selected.map(canonicalJson).join("\n")}\n`);
    if (raw.byteLength > MAX_EVENT_CHUNK_UNCOMPRESSED_BYTES) throw new Error("BCLIF event chunk exceeds uncompressed safety bound");
    const compressed = deterministicGzip(raw);
    const checksum = objectSha256(compressed);
    const digest = checksum.slice("sha256:".length);
    const start = selected[0]!.exchangeTimestamp;
    const end = selected.at(-1)!.exchangeTimestamp;
    const cutoff = Math.max(end, ...selected.map((event) => event.receivedTimestamp));
    const symbol = selected[0]!.symbol;
    if (selected.some((event) => event.symbol !== symbol)) throw new Error("A BCLIF event chunk cannot mix symbols");
    const id = deterministicBclifTileId({ checksum, end, kind, sourceId: this.sourceId, sourceVersion: this.sourceVersion, start, symbol });
    const objectPath = `events/v1/BYBIT/linear_perpetual/${symbol}/${kind}/${start}/${id}-${digest}.events.gz`;
    const existingBeforeUpload = await this.findExisting(kind, start, end, checksum);
    if (existingBeforeUpload) return this.verifyExisting(existingBeforeUpload, kind, start, end, cutoff, checksum);
    try {
      await this.objectStore.upload(objectPath, compressed, "event", "application/gzip");
    } catch (error) {
      // A crash between upload and metadata commit leaves the deterministic
      // object in place. Reuse it only after a full checksum verification.
      try {
        const stored = await this.objectStore.download(objectPath, "event");
        if (objectSha256(stored) !== checksum) throw new Error("BCLIF event object conflicts with deterministic publication identity");
      } catch {
        const raced = await this.findExisting(kind, start, end, checksum);
        if (raced) return this.verifyExisting(raced, kind, start, end, cutoff, checksum);
        throw error;
      }
    }
    const result = await this.supabase.from("bclif_canonical_event_chunks").insert({
      id,
      source_id: this.sourceId,
      event_kind: kind,
      schema_version: 1,
      source_version: this.sourceVersion,
      chunk_start: new Date(start).toISOString(),
      chunk_end: new Date(Math.max(start + 1, end)).toISOString(),
      source_cutoff_at: new Date(Math.max(start + 1, cutoff)).toISOString(),
      event_count: selected.length,
      first_event_key: selected[0]!.dedupKey,
      last_event_key: selected.at(-1)!.dedupKey,
      compression: "gzip-v1",
      bucket_id: "bclif-field-chunks",
      object_path: objectPath,
      checksum,
      compressed_bytes: compressed.byteLength,
      uncompressed_bytes: raw.byteLength,
      created_by_node_id: this.nodeId,
      ...writerFenceColumns(this.fence)
    });
    if (result.error) {
      try {
        const existing = await this.findExisting(kind, start, end, checksum);
        if (existing) {
          if (String(existing.object_path) !== objectPath) await this.objectStore.remove(objectPath, "event").catch(() => null);
          return this.verifyExisting(existing, kind, start, end, cutoff, checksum);
        }
      } catch {
        throw Object.assign(new Error("BCLIF event publication outcome is ambiguous; object preserved for recovery"), { cause: result.error });
      }
      await this.objectStore.remove(objectPath, "event").catch(() => null);
      throw result.error;
    }
    return { id, kind, objectPath, checksum, compressedBytes: compressed.byteLength, uncompressedBytes: raw.byteLength, eventCount: selected.length, start, end, cutoff };
  }

  private async findExisting(kind: BclifCanonicalEventKind, start: number, end: number, checksum: string) {
    const result = await this.supabase.from("bclif_canonical_event_chunks")
      .select("id,object_path,checksum,compressed_bytes,uncompressed_bytes,event_count")
      .eq("source_id", this.sourceId)
      .eq("event_kind", kind)
      .eq("schema_version", 1)
      .eq("chunk_start", new Date(start).toISOString())
      .eq("chunk_end", new Date(Math.max(start + 1, end)).toISOString())
      .eq("checksum", checksum)
      .limit(2);
    if (result.error) throw result.error;
    const rows = result.data || [];
    if (rows.length > 1) throw new Error("BCLIF event identity resolved to multiple immutable chunks");
    return rows[0] || null;
  }

  private async verifyExisting(row: any, kind: BclifCanonicalEventKind, start: number, end: number, cutoff: number, checksum: string) {
    if (String(row.checksum) !== checksum) throw new Error("BCLIF event retry checksum conflicts with immutable metadata");
    const bytes = await this.objectStore.download(String(row.object_path), "event");
    if (objectSha256(bytes) !== checksum) throw new Error("BCLIF finalized event object checksum verification failed");
    return {
      id: String(row.id), kind, objectPath: String(row.object_path), checksum,
      compressedBytes: Number(row.compressed_bytes), uncompressedBytes: Number(row.uncompressed_bytes),
      eventCount: Number(row.event_count), start, end, cutoff, idempotent: true
    };
  }

  async read(path: string, expectedChecksum: string) {
    const compressed = await this.objectStore.download(path, "event");
    if (objectSha256(compressed) !== expectedChecksum) throw new Error("BCLIF event chunk object checksum mismatch");
    const raw = boundedGunzip(compressed, MAX_EVENT_CHUNK_UNCOMPRESSED_BYTES);
    const lines = new TextDecoder().decode(raw).trim().split("\n").filter(Boolean);
    return lines.map((line) => validateCanonicalEvent(JSON.parse(line)));
  }

  async readAfter(sourceCutoffTimestamp: number, maximumChunks = 100_000) {
    const boundedMaximum = Math.max(1, Math.min(1_000_000, maximumChunks));
    const pageSize = Math.min(500, boundedMaximum);
    const rows: any[] = [];
    for (let offset = 0; offset < boundedMaximum; offset += pageSize) {
      const result = await this.supabase.from("bclif_canonical_event_chunks")
        .select("id,object_path,checksum,chunk_start,chunk_end,source_cutoff_at")
        .eq("source_id", this.sourceId)
        .gt("source_cutoff_at", new Date(sourceCutoffTimestamp).toISOString())
        .order("source_cutoff_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, Math.min(boundedMaximum, offset + pageSize) - 1);
      if (result.error) throw result.error;
      const page = result.data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
      if (rows.length >= boundedMaximum) throw Object.assign(new Error("BCLIF recovery exceeds configured event-chunk safety bound; refusing partial replay"), { code: "BCLIF_RECOVERY_BOUND" });
    }
    const events: BclifCanonicalEvent[] = [];
    for (const row of rows) {
      const chunk = await this.read(String(row.object_path), String(row.checksum));
      events.push(...chunk.filter((event) => Math.max(event.exchangeTimestamp, event.receivedTimestamp) > sourceCutoffTimestamp));
    }
    const unique = new Map<string, BclifCanonicalEvent>();
    for (const event of events) unique.set(bclifArchivedEventIdentity(event), event);
    return [...unique.values()].sort(compareCanonicalEventsByKnownAt);
  }

  /**
   * Reconcile crash-spooled events against immutable archives before creating
   * another chunk. This closes the archive-commit -> dedup-commit crash window.
   */
  async archivedDedupKeys(candidates: readonly BclifCanonicalEvent[], maximumChunks = 5_000) {
    const boundedMaximum = Math.max(1, Math.min(100_000, maximumChunks));
    const found = new Set<string>();
    for (const kind of [...new Set(candidates.map((event) => event.kind))]) {
      if (!STORED_EVENT_KINDS.has(kind)) continue;
      const selected = candidates.filter((event) => event.kind === kind);
      if (!selected.length) continue;
      const start = Math.min(...selected.map((event) => event.exchangeTimestamp));
      const end = Math.max(...selected.map((event) => event.exchangeTimestamp));
      const rows: any[] = [];
      const pageSize = Math.min(500, boundedMaximum);
      for (let offset = 0; offset <= boundedMaximum; offset += pageSize) {
        const result = await this.supabase.from("bclif_canonical_event_chunks")
          .select("id,object_path,checksum")
          .eq("source_id", this.sourceId)
          .eq("event_kind", kind)
          .lte("chunk_start", new Date(end).toISOString())
          .gte("chunk_end", new Date(start).toISOString())
          .order("chunk_start", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, Math.min(boundedMaximum, offset + pageSize - 1));
        if (result.error) throw result.error;
        const page = result.data || [];
        rows.push(...page);
        if (rows.length > boundedMaximum) throw Object.assign(new Error("BCLIF archive reconciliation exceeds its chunk safety bound; refusing partial deduplication"), { code: "BCLIF_ARCHIVE_RECONCILIATION_BOUND" });
        if (page.length < pageSize) break;
      }
      const wanted = new Set(selected.map(bclifArchivedEventIdentity));
      for (const row of rows) {
        for (const event of await this.read(String(row.object_path), String(row.checksum))) {
          const identity = bclifArchivedEventIdentity(event);
          if (wanted.has(identity)) found.add(identity);
        }
      }
    }
    return found;
  }
}

export function bclifArchivedEventIdentity(event: Pick<BclifCanonicalEvent, "kind" | "dedupKey">) {
  return `${event.kind}:${event.dedupKey}`;
}

export function deterministicGzip(bytes: Uint8Array) {
  return new Uint8Array(gzipSync(bytes, { level: 9, mtime: 0 } as any));
}

export function boundedGunzip(bytes: Uint8Array, maximumBytes: number) {
  const output = new Uint8Array(gunzipSync(bytes, { maxOutputLength: maximumBytes }));
  if (output.byteLength > maximumBytes) throw new Error("BCLIF gzip output exceeds safety bound");
  return output;
}

function compareCanonicalEvents(a: BclifCanonicalEvent, b: BclifCanonicalEvent) {
  return a.exchangeTimestamp - b.exchangeTimestamp
    || String(a.sourceSequence || "").localeCompare(String(b.sourceSequence || ""), "en", { numeric: true })
    || a.eventId.localeCompare(b.eventId);
}

function compareCanonicalEventsByKnownAt(a: BclifCanonicalEvent, b: BclifCanonicalEvent) {
  return Math.max(a.exchangeTimestamp, a.receivedTimestamp) - Math.max(b.exchangeTimestamp, b.receivedTimestamp)
    || compareCanonicalEvents(a, b);
}

function validateCanonicalEvent(value: unknown): BclifCanonicalEvent {
  const event = value as BclifCanonicalEvent;
  if (event?.schemaVersion !== 1 || event.venue !== "BYBIT" || !STORED_EVENT_KINDS.has(event.kind)) throw new Error("Invalid canonical event chunk record");
  if (!/^sha256:[a-f0-9]{64}$/.test(event.dedupKey) || !Number.isFinite(event.exchangeTimestamp) || !Number.isFinite(event.receivedTimestamp)) {
    throw new Error("Corrupt canonical event chunk record");
  }
  return event;
}
