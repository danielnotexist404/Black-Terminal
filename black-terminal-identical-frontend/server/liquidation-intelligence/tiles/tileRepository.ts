import { createHash } from "node:crypto";
import { BCLIF_TILE_SCHEMA_VERSION, type BclifDecodedTile, type BclifTileHorizon, type BclifTileInput, type BclifTileMetadata, type BclifWriterFence } from "../contracts.ts";
import { BclifObjectStore } from "../state/objectStore.ts";
import { decodeBclifTile, encodeBclifTile } from "./tileCodec.ts";
import { validateWriterFence, writerFenceColumns } from "../state/writerFence.ts";

export class BclifTileRepository {
  private readonly supabase: any;
  private readonly objectStore: BclifObjectStore;
  private readonly sourceId: string;
  private readonly nodeId: string;
  private readonly fence: BclifWriterFence;
  constructor(
    supabase: any,
    objectStore: BclifObjectStore,
    sourceId: string,
    nodeId: string,
    fence: BclifWriterFence
  ) { this.supabase = supabase; this.objectStore = objectStore; this.sourceId = sourceId; this.nodeId = nodeId; this.fence = validateWriterFence(fence); }

  async publish(tile: BclifTileInput): Promise<BclifTileMetadata> {
    if (tile.authority !== "PERSISTENT_NODE" && tile.authority !== "REPLAY") throw new Error("Only collector-owned BCLIF tiles may be published");
    const encoded = encodeBclifTile(tile);
    const digest = encoded.objectChecksum.slice("sha256:".length);
    const objectPath = `v${BCLIF_TILE_SCHEMA_VERSION}/BYBIT/linear_perpetual/${tile.symbol}/${tile.horizon}/${tile.startTime}/${tile.tileId}-${digest}.bclif`;
    const existingBeforeUpload = await this.findExisting(tile);
    if (existingBeforeUpload) return this.verifyExisting(existingBeforeUpload, tile, encoded.objectChecksum);
    try {
      await this.objectStore.upload(objectPath, encoded.bytes, "tile");
    } catch (error) {
      const raced = await this.findExisting(tile);
      if (raced) return this.verifyExisting(raced, tile, encoded.objectChecksum);
      try {
        const stored = await this.objectStore.download(objectPath, "tile");
        const checksum = `sha256:${createHash("sha256").update(stored).digest("hex")}`;
        if (checksum !== encoded.objectChecksum) throw new Error("BCLIF tile conflicts with deterministic publication identity");
      } catch {
        throw error;
      }
    }
    const row = {
      id: tile.tileId,
      source_id: this.sourceId,
      model_version: tile.modelVersion,
      horizon: tile.horizon,
      chunk_start: iso(tile.startTime),
      chunk_end: iso(tile.endTime),
      columns: tile.columns,
      rows: tile.rows,
      price_min: tile.minPrice,
      price_max: tile.maxPrice,
      compression: "gzip-v1",
      object_path: objectPath,
      checksum: encoded.objectChecksum,
      compressed_bytes: encoded.bytes.byteLength,
      metadata: { payloadChecksum: encoded.payloadChecksum, codec: "BCLF_GZIP_V1", immutable: true },
      schema_version: BCLIF_TILE_SCHEMA_VERSION,
      tile_version: tile.tileVersion ?? 1,
      time_step_ms: tile.timeStepMs,
      price_step: tile.priceStep,
      bucket_id: "bclif-field-chunks",
      source_cutoff_at: iso(tile.sourceCutoffTimestamp),
      coverage_quality: tile.coverageQuality,
      model_authority: tile.authority,
      channel_manifest: { channelOrder: encoded.header.channelOrder, gridOrder: "COLUMN_MAJOR_TIME_THEN_PRICE_ASC" },
      scale_metadata: encoded.header.scales,
      publication_state: "FINALIZED",
      created_by_node_id: this.nodeId,
      published_at: iso(tile.createdAt),
      ...writerFenceColumns(this.fence)
    };
    const result = await this.supabase.from("bclif_field_chunks").insert(row).select("id").single();
    if (result.error) {
      try {
        const existing = await this.findExisting(tile);
        if (existing) {
          if (String(existing.object_path) !== objectPath) await this.objectStore.remove(objectPath, "tile").catch(() => null);
          return this.verifyExisting(existing, tile, encoded.objectChecksum);
        }
      } catch (reconciliationError) {
        if (isUniqueViolation(result.error)) throw reconciliationError;
        // A failed reconciliation query makes the insert outcome ambiguous.
        // Preserve the object; deleting it could strand a committed row.
        throw Object.assign(new Error("BCLIF tile publication outcome is ambiguous; object preserved for recovery"), { cause: result.error });
      }
      await this.objectStore.remove(objectPath, "tile").catch(() => null);
      throw result.error;
    }
    return {
      tileId: tile.tileId,
      venue: tile.venue,
      symbol: tile.symbol,
      horizon: tile.horizon,
      startTime: tile.startTime,
      endTime: tile.endTime,
      minPrice: tile.minPrice,
      maxPrice: tile.maxPrice,
      timeStepMs: tile.timeStepMs,
      priceStep: tile.priceStep,
      columns: tile.columns,
      rows: tile.rows,
      modelVersion: tile.modelVersion,
      schemaVersion: BCLIF_TILE_SCHEMA_VERSION,
      objectPath,
      checksum: encoded.objectChecksum,
      sourceCutoffTimestamp: tile.sourceCutoffTimestamp,
      coverageQuality: tile.coverageQuality,
      compressedBytes: encoded.bytes.byteLength,
      createdAt: tile.createdAt
    };
  }

  /**
   * Publish one cumulative live-edge object and atomically advance the unique
   * STAGING metadata pointer for its UTC bucket. Objects are immutable; only
   * the pointer advances under the database's monotonic STAGING guard.
   */
  async publishStaging(tile: BclifTileInput): Promise<BclifTileMetadata> {
    if (tile.authority !== "PERSISTENT_NODE" || tile.columns < 2) throw new Error("BCLIF live edge requires at least two persistent columns");
    const encoded = encodeBclifTile(tile);
    const digest = encoded.objectChecksum.slice("sha256:".length);
    const objectPath = `v${BCLIF_TILE_SCHEMA_VERSION}/BYBIT/linear_perpetual/${tile.symbol}/${tile.horizon}/${tile.startTime}/${tile.tileId}-${digest}.bclif`;
    // A previous attempt may have finalized this exact horizon before a later
    // sibling failed. Treat the immutable finalized row as an idempotent
    // success instead of trying to create a conflicting STAGING identity.
    const finalized = await this.findExisting(tile);
    if (finalized) return this.verifyExisting(finalized, tile, encoded.objectChecksum);
    let existing = await this.findStaging(tile);
    if (existing && Date.parse(String(existing.source_cutoff_at)) >= tile.sourceCutoffTimestamp) {
      existing = await this.adoptStagingAuthority(existing);
      if (String(existing.checksum) !== encoded.objectChecksum) {
        if (Date.parse(String(existing.source_cutoff_at)) === tile.sourceCutoffTimestamp) throw new Error("BCLIF live-edge retry conflicts at the same source cutoff");
        return this.metadataFromRow(existing, tile);
      }
      return this.verifyExisting(existing, tile, encoded.objectChecksum);
    }
    await this.uploadOrVerify(objectPath, encoded.bytes, encoded.objectChecksum);
    const mutable = {
      chunk_end: iso(tile.endTime),
      columns: tile.columns,
      object_path: objectPath,
      checksum: encoded.objectChecksum,
      compressed_bytes: encoded.bytes.byteLength,
      metadata: { payloadChecksum: encoded.payloadChecksum, codec: "BCLF_GZIP_V1", immutableObject: true, liveEdge: true },
      source_cutoff_at: iso(tile.sourceCutoffTimestamp),
      coverage_quality: tile.coverageQuality,
      channel_manifest: { channelOrder: encoded.header.channelOrder, gridOrder: "COLUMN_MAJOR_TIME_THEN_PRICE_ASC" },
      scale_metadata: encoded.header.scales,
      published_at: iso(tile.createdAt),
      ...writerFenceColumns(this.fence)
    };
    if (!existing) {
      const inserted = await this.supabase.from("bclif_field_chunks").insert({
        id: tile.tileId,
        source_id: this.sourceId,
        model_version: tile.modelVersion,
        horizon: tile.horizon,
        chunk_start: iso(tile.startTime),
        rows: tile.rows,
        price_min: tile.minPrice,
        price_max: tile.maxPrice,
        compression: "gzip-v1",
        schema_version: BCLIF_TILE_SCHEMA_VERSION,
        tile_version: tile.tileVersion ?? 1,
        time_step_ms: tile.timeStepMs,
        price_step: tile.priceStep,
        bucket_id: "bclif-field-chunks",
        model_authority: tile.authority,
        publication_state: "STAGING",
        created_by_node_id: this.nodeId,
        ...mutable
      }).select("id").single();
      if (inserted.error) {
        existing = await this.findStaging(tile);
        if (!existing || String(existing.checksum) !== encoded.objectChecksum) {
          throw Object.assign(new Error("BCLIF STAGING insert outcome is ambiguous; object preserved"), { cause: inserted.error });
        }
      }
    } else {
      const previousPath = String(existing.object_path);
      const advanced = await this.supabase.from("bclif_field_chunks").update(mutable)
        .eq("id", existing.id)
        .eq("publication_state", "STAGING")
        .eq("source_cutoff_at", existing.source_cutoff_at)
        .select("id");
      if (advanced.error || !advanced.data?.length) {
        const reconciled = await this.findStaging(tile);
        if (!reconciled || String(reconciled.checksum) !== encoded.objectChecksum) {
          throw Object.assign(new Error("BCLIF STAGING advance outcome is ambiguous; object preserved"), { cause: advanced.error });
        }
      }
      if (previousPath !== objectPath) await this.queueRetiredStagingObject(previousPath, tile.createdAt).catch(() => null);
    }
    const row = await this.findStaging(tile);
    if (!row || String(row.checksum) !== encoded.objectChecksum) throw new Error("BCLIF STAGING pointer did not resolve to the published object");
    return this.verifyExisting(row, tile, encoded.objectChecksum);
  }

  async finalizeStaging(tile: BclifTileInput): Promise<BclifTileMetadata> {
    const encoded = encodeBclifTile(tile);
    const existingFinalized = await this.findExisting(tile);
    if (existingFinalized) return this.verifyExisting(existingFinalized, tile, encoded.objectChecksum);
    let staging = await this.findStaging(tile);
    if (!staging || String(staging.checksum) !== encoded.objectChecksum) {
      await this.publishStaging(tile);
      staging = await this.findStaging(tile);
    }
    if (!staging || String(staging.checksum) !== encoded.objectChecksum) throw new Error("BCLIF cannot finalize a missing live-edge revision");
    const result = await this.supabase.from("bclif_field_chunks").update({ publication_state: "FINALIZED", published_at: iso(tile.createdAt) })
      .eq("id", staging.id)
      .eq("publication_state", "STAGING")
      .eq("checksum", encoded.objectChecksum)
      .select("id");
    if (result.error || !result.data?.length) {
      const finalized = await this.findExisting(tile);
      if (!finalized || String(finalized.checksum) !== encoded.objectChecksum) throw result.error || new Error("BCLIF STAGING promotion was fenced or lost");
      return this.verifyExisting(finalized, tile, encoded.objectChecksum);
    }
    return this.verifyExisting({ ...staging, publication_state: "FINALIZED" }, tile, encoded.objectChecksum);
  }

  private async findStaging(tile: BclifTileInput) {
    const result = await this.supabase.from("bclif_field_chunks")
      .select("id,object_path,checksum,compressed_bytes,created_at,published_at,source_cutoff_at,coverage_quality,price_min,price_max,time_step_ms,price_step,columns,rows,writer_instance_id,fencing_epoch")
      .eq("source_id", this.sourceId)
      .eq("horizon", tile.horizon)
      .eq("chunk_start", iso(tile.startTime))
      .eq("model_version", tile.modelVersion)
      .eq("schema_version", BCLIF_TILE_SCHEMA_VERSION)
      .eq("tile_version", tile.tileVersion ?? 1)
      .eq("publication_state", "STAGING")
      .limit(2);
    if (result.error) throw result.error;
    if ((result.data || []).length > 1) throw new Error("BCLIF source has multiple STAGING authorities for one UTC bucket");
    return result.data?.[0] || null;
  }

  private async adoptStagingAuthority(row: any) {
    if (String(row.writer_instance_id) === this.fence.instanceId && Number(row.fencing_epoch) === this.fence.fencingEpoch) return row;
    const adopted = await this.supabase.from("bclif_field_chunks").update(writerFenceColumns(this.fence))
      .eq("id", row.id)
      .eq("publication_state", "STAGING")
      .eq("writer_instance_id", row.writer_instance_id)
      .eq("fencing_epoch", row.fencing_epoch)
      .select("id,object_path,checksum,compressed_bytes,created_at,published_at,source_cutoff_at,coverage_quality,price_min,price_max,time_step_ms,price_step,columns,rows,writer_instance_id,fencing_epoch");
    if (adopted.error || !adopted.data?.length) throw adopted.error || new Error("BCLIF STAGING authority adoption was fenced");
    return adopted.data[0];
  }

  private async uploadOrVerify(path: string, bytes: Uint8Array, checksum: string) {
    try {
      await this.objectStore.upload(path, bytes, "tile");
    } catch (error) {
      try {
        const stored = await this.objectStore.download(path, "tile");
        if (`sha256:${createHash("sha256").update(stored).digest("hex")}` !== checksum) throw error;
      } catch {
        throw error;
      }
    }
  }

  private async queueRetiredStagingObject(objectPath: string, now: number) {
    const result = await this.supabase.from("bclif_object_deletion_queue").insert({
      source_id: this.sourceId,
      bucket_id: "bclif-field-chunks",
      object_path: objectPath,
      object_kind: "TILE",
      reason: "SUPERSEDED_STAGING_REVISION",
      state: "PENDING",
      not_before: iso(now + 60 * 60_000),
      ...writerFenceColumns(this.fence)
    });
    if (result.error && !isUniqueViolation(result.error)) throw result.error;
  }

  private metadataFromRow(row: any, tile: BclifTileInput): BclifTileMetadata {
    return {
      tileId: String(row.id), venue: tile.venue, symbol: tile.symbol, horizon: tile.horizon,
      startTime: tile.startTime, endTime: Date.parse(String(row.chunk_end || row.source_cutoff_at)),
      minPrice: Number(row.price_min), maxPrice: Number(row.price_max), timeStepMs: Number(row.time_step_ms),
      priceStep: Number(row.price_step), columns: Number(row.columns), rows: Number(row.rows), modelVersion: tile.modelVersion,
      schemaVersion: BCLIF_TILE_SCHEMA_VERSION, objectPath: String(row.object_path), checksum: String(row.checksum),
      sourceCutoffTimestamp: Date.parse(String(row.source_cutoff_at)), coverageQuality: String(row.coverage_quality),
      compressedBytes: Number(row.compressed_bytes), createdAt: Date.parse(String(row.published_at || row.created_at))
    };
  }

  private async findExisting(tile: BclifTileInput) {
    const result = await this.supabase.from("bclif_field_chunks")
      .select("id,object_path,checksum,compressed_bytes,created_at,published_at,source_cutoff_at,coverage_quality,price_min,price_max,time_step_ms,price_step,columns,rows")
      .eq("source_id", this.sourceId)
      .eq("horizon", tile.horizon)
      .eq("chunk_start", iso(tile.startTime))
      .eq("chunk_end", iso(tile.endTime))
      .eq("model_version", tile.modelVersion)
      .eq("schema_version", BCLIF_TILE_SCHEMA_VERSION)
      .eq("tile_version", tile.tileVersion ?? 1)
      .eq("publication_state", "FINALIZED")
      .limit(2);
    if (result.error) throw result.error;
    const rows = result.data || [];
    if (rows.length > 1) throw new Error("BCLIF tile identity resolved to multiple finalized rows");
    return rows[0] || null;
  }

  private async verifyExisting(row: any, tile: BclifTileInput, expectedChecksum: string): Promise<BclifTileMetadata> {
    if (row.checksum !== expectedChecksum) throw new Error("BCLIF tile retry checksum conflicts with the finalized immutable version");
    const stored = await this.objectStore.download(String(row.object_path), "tile");
    const actualChecksum = `sha256:${createHash("sha256").update(stored).digest("hex")}`;
    if (actualChecksum !== expectedChecksum) throw new Error("BCLIF finalized tile object checksum verification failed");
    return {
      tileId: String(row.id),
      venue: tile.venue,
      symbol: tile.symbol,
      horizon: tile.horizon,
      startTime: tile.startTime,
      endTime: tile.endTime,
      minPrice: Number(row.price_min),
      maxPrice: Number(row.price_max),
      timeStepMs: Number(row.time_step_ms),
      priceStep: Number(row.price_step),
      columns: Number(row.columns),
      rows: Number(row.rows),
      modelVersion: tile.modelVersion,
      schemaVersion: BCLIF_TILE_SCHEMA_VERSION,
      objectPath: String(row.object_path),
      checksum: String(row.checksum),
      sourceCutoffTimestamp: Date.parse(String(row.source_cutoff_at)),
      coverageQuality: String(row.coverage_quality),
      compressedBytes: Number(row.compressed_bytes),
      createdAt: Date.parse(String(row.published_at || row.created_at))
    };
  }

  async recordSupersession(sourceTileIds: string[], replacementTileId: string, reason: string) {
    if (!sourceTileIds.length || sourceTileIds.includes(replacementTileId)) throw new Error("Invalid BCLIF tile supersession");
    const rows = [...new Set(sourceTileIds)].map((tileId) => ({
      superseded_tile_id: tileId,
      replacement_tile_id: replacementTileId,
      reason,
      superseded_by_node_id: this.nodeId,
      ...writerFenceColumns(this.fence)
    }));
    const result = await this.supabase.from("bclif_tile_supersessions").insert(rows);
    if (result.error) throw result.error;
  }

  /**
   * Restore the verified finalized base history used by fixed UTC rollups.
   * Merely trusting metadata here would let a corrupt/missing object poison all
   * future horizons after a process restart, so every object is checksummed and
   * decoded before it enters the rollup window.
   */
  async loadRecentFinalized(symbol: string, modelVersion: string, horizon: BclifTileHorizon = "6H", limit = 240): Promise<BclifDecodedTile[]> {
    const bounded = Math.max(1, Math.min(1_000, limit));
    const result = await this.supabase.from("bclif_field_chunks")
      .select("id,object_path,checksum,chunk_start,chunk_end,source_cutoff_at,coverage_quality,published_at,created_at,tile_version,schema_version,model_version,horizon,publication_state")
      .eq("source_id", this.sourceId)
      .eq("horizon", horizon)
      .eq("model_version", modelVersion)
      .eq("schema_version", BCLIF_TILE_SCHEMA_VERSION)
      .eq("publication_state", "FINALIZED")
      .order("chunk_start", { ascending: false })
      .limit(Math.min(2_000, bounded * 4));
    if (result.error) throw result.error;
    const rows = result.data || [];
    const ids = rows.map((row: any) => String(row.id));
    const superseded = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const query = await this.supabase.from("bclif_tile_supersessions")
        .select("superseded_tile_id")
        .in("superseded_tile_id", ids.slice(offset, offset + 500));
      if (query.error) throw query.error;
      for (const row of query.data || []) superseded.add(String(row.superseded_tile_id));
    }
    const selected = new Map<string, BclifDecodedTile>();
    for (const row of rows) {
      if (superseded.has(String(row.id))) continue;
      const bytes = await this.objectStore.download(String(row.object_path), "tile");
      const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (checksum !== String(row.checksum)) throw new Error(`BCLIF finalized tile ${row.id} failed restart checksum verification`);
      const tile = decodeBclifTile(bytes);
      const startTime = Date.parse(String(row.chunk_start));
      const endTime = Date.parse(String(row.chunk_end));
      const sourceCutoff = Date.parse(String(row.source_cutoff_at));
      if (
        tile.tileId !== String(row.id)
        || tile.symbol !== symbol
        || tile.horizon !== horizon
        || tile.modelVersion !== modelVersion
        || tile.schemaVersion !== BCLIF_TILE_SCHEMA_VERSION
        || tile.authority !== "PERSISTENT_NODE"
        || tile.startTime !== startTime
        || tile.endTime !== endTime
        || tile.sourceCutoffTimestamp !== sourceCutoff
        || tile.tileVersion !== Number(row.tile_version)
      ) throw new Error(`BCLIF finalized tile ${row.id} metadata/object identity mismatch`);
      tile.coverageQuality = String(row.coverage_quality) as BclifDecodedTile["coverageQuality"];
      tile.createdAt = Date.parse(String(row.published_at || row.created_at));
      const key = `${startTime}:${endTime}`;
      const current = selected.get(key);
      if (!current || tile.tileVersion > current.tileVersion || (tile.tileVersion === current.tileVersion && tile.sourceCutoffTimestamp > current.sourceCutoffTimestamp)) selected.set(key, tile);
    }
    return [...selected.values()].sort((left, right) => left.startTime - right.startTime).slice(-bounded);
  }

  /** Restore the single authoritative cumulative STAGING pointer per horizon. */
  async loadCurrentStaging(symbol: string, modelVersion: string): Promise<Map<BclifTileHorizon, BclifDecodedTile>> {
    const result = await this.supabase.from("bclif_field_chunks")
      .select("id,object_path,checksum,chunk_start,chunk_end,source_cutoff_at,coverage_quality,published_at,created_at,tile_version,schema_version,model_version,horizon,publication_state")
      .eq("source_id", this.sourceId)
      .eq("model_version", modelVersion)
      .eq("schema_version", BCLIF_TILE_SCHEMA_VERSION)
      .eq("tile_version", 1)
      .eq("publication_state", "STAGING")
      .order("source_cutoff_at", { ascending: false })
      .limit(16);
    if (result.error) throw result.error;
    const output = new Map<BclifTileHorizon, BclifDecodedTile>();
    for (const row of result.data || []) {
      const horizon = String(row.horizon) as BclifTileHorizon;
      if (output.has(horizon)) throw new Error(`BCLIF source has multiple STAGING authorities for ${horizon}`);
      const bytes = await this.objectStore.download(String(row.object_path), "tile");
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== String(row.checksum)) throw new Error(`BCLIF STAGING ${row.id} failed restart checksum verification`);
      const tile = decodeBclifTile(bytes);
      if (
        tile.tileId !== String(row.id)
        || tile.symbol !== symbol
        || tile.modelVersion !== modelVersion
        || tile.horizon !== horizon
        || tile.schemaVersion !== BCLIF_TILE_SCHEMA_VERSION
        || tile.tileVersion !== 1
        || tile.authority !== "PERSISTENT_NODE"
        || tile.startTime !== Date.parse(String(row.chunk_start))
        || tile.endTime !== Date.parse(String(row.chunk_end))
        || tile.sourceCutoffTimestamp !== Date.parse(String(row.source_cutoff_at))
      ) throw new Error(`BCLIF STAGING ${row.id} metadata/object identity mismatch`);
      tile.coverageQuality = String(row.coverage_quality) as BclifDecodedTile["coverageQuality"];
      tile.createdAt = Date.parse(String(row.published_at || row.created_at));
      output.set(horizon, tile);
    }
    return output;
  }
}

function iso(value: number) { return new Date(value).toISOString(); }
function isUniqueViolation(error: unknown) { return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505"); }
