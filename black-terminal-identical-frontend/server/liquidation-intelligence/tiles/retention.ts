import { BCLIF_TILE_SCHEMA_VERSION, type BclifWriterFence } from "../contracts.ts";
import { boundedGunzip } from "../state/eventChunkRepository.ts";
import { validateCheckpointState } from "../state/checkpointRepository.ts";
import { BclifObjectStore, objectSha256, validateBclifObjectPath, type BclifObjectKind } from "../state/objectStore.ts";
import { validateWriterFence, writerFenceColumns } from "../state/writerFence.ts";
import { decodeBclifTile } from "./tileCodec.ts";

const KIND_MAP: Record<string, BclifObjectKind> = { TILE: "tile", EVENT_CHUNK: "event", CHECKPOINT: "checkpoint" };
const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;

/**
 * Plans and consumes only deletions whose recoverability can be re-proven at
 * execution time. Metadata is immutable and retained; object deletion never
 * makes a currently manifestable tile or a required restart segment vanish.
 */
export class BclifRetentionWorker {
  private readonly supabase: any;
  private readonly objectStore: BclifObjectStore;
  private readonly sourceId: string;
  private readonly nodeId: string;
  private readonly fence: BclifWriterFence;

  constructor(supabase: any, objectStore: BclifObjectStore, sourceId: string, nodeId: string, fence: BclifWriterFence) {
    this.supabase = supabase;
    this.objectStore = objectStore;
    this.sourceId = sourceId;
    this.nodeId = nodeId;
    this.fence = validateWriterFence(fence);
    if (this.fence.nodeId !== nodeId) throw new Error("BCLIF retention node/fence identity mismatch");
  }

  async queueVerifiedSupersededTiles(now = Date.now(), graceMs = 24 * 60 * 60_000, limit = 100) {
    const cutoff = new Date(now - Math.max(60_000, graceMs)).toISOString();
    const supersessions = await this.supabase.from("bclif_tile_supersessions")
      .select("superseded_tile_id,replacement_tile_id,superseded_at")
      .lte("superseded_at", cutoff)
      .order("superseded_at", { ascending: true })
      .limit(Math.max(1, Math.min(1_000, limit)));
    if (supersessions.error) throw supersessions.error;
    let queued = 0;
    for (const supersession of supersessions.data || []) {
      const source = await this.tileById(String(supersession.superseded_tile_id));
      if (!source || source.publication_state !== "FINALIZED" || String(source.source_id) !== this.sourceId) continue;
      await this.verifyFinalizedReplacement(String(supersession.replacement_tile_id), source);
      const result = await this.supabase.from("bclif_object_deletion_queue").insert({
        source_id: this.sourceId,
        bucket_id: "bclif-field-chunks",
        object_path: String(source.object_path),
        object_kind: "TILE",
        reason: "SUPERSEDED_FINALIZED_TILE",
        state: "PENDING",
        not_before: new Date(now + Math.max(60_000, graceMs)).toISOString(),
        ...writerFenceColumns(this.fence)
      });
      if (result.error && !isUniqueViolation(result.error)) throw result.error;
      if (!result.error) queued += 1;
    }
    return queued;
  }

  async runOnce(now = Date.now(), limit = 25) {
    const staleClaim = new Date(now - 5 * 60_000).toISOString();
    const reclaim = await this.supabase.from("bclif_object_deletion_queue").update({
      state: "FAILED",
      claimed_by_node_id: null,
      claimed_at: null,
      last_error_code: "CLAIM_LEASE_EXPIRED",
      ...writerFenceColumns(this.fence)
    }).eq("source_id", this.sourceId).eq("state", "CLAIMED").lt("claimed_at", staleClaim);
    if (reclaim.error) throw reclaim.error;
    const selected = await this.supabase.from("bclif_object_deletion_queue")
      .select("id,source_id,object_path,object_kind,reason")
      .eq("source_id", this.sourceId)
      .in("state", ["PENDING", "FAILED"])
      .lte("not_before", new Date(now).toISOString())
      .order("not_before", { ascending: true })
      .limit(Math.max(1, Math.min(100, limit)));
    if (selected.error) throw selected.error;
    let completed = 0;
    for (const row of selected.data || []) {
      const kind = KIND_MAP[row.object_kind];
      try {
        const claim = await this.supabase.from("bclif_object_deletion_queue").update({
          state: "CLAIMED",
          claimed_by_node_id: this.nodeId,
          claimed_at: new Date(now).toISOString(),
          last_error_code: null,
          ...writerFenceColumns(this.fence)
        }).eq("id", row.id).eq("source_id", this.sourceId).in("state", ["PENDING", "FAILED"]).select("id");
        if (claim.error) throw claim.error;
        if (!claim.data?.length) continue;
        if (!kind || String(row.source_id) !== this.sourceId) throw coded("RETENTION_SCOPE_INVALID");
        validateBclifObjectPath(String(row.object_path), kind);
        await this.assertSafeToDelete(row, kind);
        await this.objectStore.remove(String(row.object_path), kind);
        const done = await this.supabase.from("bclif_object_deletion_queue").update({
          state: "OBJECT_DELETED",
          completed_at: new Date().toISOString(),
          ...writerFenceColumns(this.fence)
        }).eq("id", row.id)
          .eq("source_id", this.sourceId)
          .eq("state", "CLAIMED")
          .eq("claimed_by_node_id", this.nodeId)
          .eq("writer_instance_id", this.fence.instanceId)
          .eq("fencing_epoch", this.fence.fencingEpoch)
          .select("id");
        if (done.error || !done.data?.length) throw done.error || coded("RETENTION_COMPLETION_FENCED");
        completed += 1;
      } catch (error) {
        try {
          await this.supabase.from("bclif_object_deletion_queue").update({
            state: "FAILED",
            claimed_by_node_id: null,
            claimed_at: null,
            last_error_code: safeCode(error),
            not_before: new Date(now + 60 * 60_000).toISOString(),
            ...writerFenceColumns(this.fence)
          }).eq("id", row.id)
            .eq("source_id", this.sourceId)
            .eq("state", "CLAIMED")
            .eq("claimed_by_node_id", this.nodeId)
            .eq("writer_instance_id", this.fence.instanceId)
            .eq("fencing_epoch", this.fence.fencingEpoch);
        } catch { /* authority loss is handled by the collector heartbeat */ }
      }
    }
    return completed;
  }

  private async assertSafeToDelete(row: any, kind: BclifObjectKind) {
    if (kind === "tile") return this.assertTileSafe(row);
    if (kind === "event") return this.assertEventSafe(row);
    return this.assertCheckpointSafe(row);
  }

  private async assertTileSafe(row: any) {
    const path = String(row.object_path);
    if (row.reason === "SUPERSEDED_STAGING_REVISION") {
      const referenced = await this.supabase.from("bclif_field_chunks").select("id").eq("source_id", this.sourceId).eq("object_path", path).limit(1);
      if (referenced.error) throw referenced.error;
      if (referenced.data?.length) throw coded("STAGING_OBJECT_STILL_REFERENCED");
      return;
    }
    if (row.reason !== "SUPERSEDED_FINALIZED_TILE") throw coded("TILE_RETENTION_REASON_NOT_ALLOWED");
    const source = await this.tileByPath(path);
    if (!source || source.publication_state !== "FINALIZED") throw coded("SUPERSEDED_TILE_METADATA_MISSING");
    const link = await this.supabase.from("bclif_tile_supersessions")
      .select("replacement_tile_id")
      .eq("superseded_tile_id", source.id)
      .limit(2);
    if (link.error) throw link.error;
    if (link.data?.length !== 1) throw coded("SUPERSEDED_TILE_LINK_INVALID");
    await this.verifyFinalizedReplacement(String(link.data[0].replacement_tile_id), source);
  }

  private async assertEventSafe(row: any) {
    if (row.reason !== "EVENT_ARCHIVE_BEFORE_VERIFIED_CHECKPOINT") throw coded("EVENT_RETENTION_REASON_NOT_ALLOWED");
    const event = await this.supabase.from("bclif_canonical_event_chunks")
      .select("source_cutoff_at")
      .eq("source_id", this.sourceId)
      .eq("object_path", String(row.object_path))
      .limit(2);
    if (event.error) throw event.error;
    if (event.data?.length !== 1) throw coded("EVENT_ARCHIVE_METADATA_INVALID");
    const cutoff = Date.parse(String(event.data[0].source_cutoff_at));
    const newer = await this.verifiedNewerCheckpoints(cutoff, 2);
    if (newer < 2) throw coded("EVENT_ARCHIVE_RECOVERY_NOT_REDUNDANT");
  }

  private async assertCheckpointSafe(row: any) {
    if (row.reason !== "SUPERSEDED_CHECKPOINT") throw coded("CHECKPOINT_RETENTION_REASON_NOT_ALLOWED");
    const target = await this.supabase.from("bclif_cohort_checkpoints")
      .select("source_cutoff_at")
      .eq("source_id", this.sourceId)
      .eq("object_path", String(row.object_path))
      .limit(2);
    if (target.error) throw target.error;
    if (target.data?.length !== 1) throw coded("CHECKPOINT_METADATA_INVALID");
    const cutoff = Date.parse(String(target.data[0].source_cutoff_at));
    const newer = await this.verifiedNewerCheckpoints(cutoff, 3);
    if (newer < 3) throw coded("CHECKPOINT_RECOVERY_RESERVE_TOO_SMALL");
  }

  private async verifiedNewerCheckpoints(cutoff: number, required: number) {
    const result = await this.supabase.from("bclif_cohort_checkpoints")
      .select("model_version,source_version,schema_version,object_path,checksum")
      .eq("source_id", this.sourceId)
      .gt("source_cutoff_at", new Date(cutoff).toISOString())
      .order("source_cutoff_at", { ascending: false })
      .limit(Math.max(required * 3, 10));
    if (result.error) throw result.error;
    let verified = 0;
    for (const checkpoint of result.data || []) {
      try {
        if (Number(checkpoint.schema_version) !== 1) continue;
        const bytes = await this.objectStore.download(String(checkpoint.object_path), "checkpoint");
        if (objectSha256(bytes) !== String(checkpoint.checksum)) continue;
        const state = JSON.parse(new TextDecoder().decode(boundedGunzip(bytes, MAX_CHECKPOINT_BYTES)));
        validateCheckpointState(state, String(checkpoint.model_version), String(checkpoint.source_version));
        verified += 1;
        if (verified >= required) break;
      } catch { /* a corrupt candidate is not recovery evidence */ }
    }
    return verified;
  }

  private async verifyFinalizedReplacement(id: string, source: any) {
    const replacement = await this.tileById(id);
    if (!replacement || replacement.publication_state !== "FINALIZED" || String(replacement.source_id) !== this.sourceId) throw coded("REPLACEMENT_TILE_NOT_FINALIZED");
    const bytes = await this.objectStore.download(String(replacement.object_path), "tile");
    if (objectSha256(bytes) !== String(replacement.checksum)) throw coded("REPLACEMENT_TILE_CHECKSUM_INVALID");
    let tile;
    try { tile = decodeBclifTile(bytes); }
    catch { throw coded("REPLACEMENT_TILE_CODEC_INVALID"); }
    if (
      tile.tileId !== String(replacement.id)
      || tile.schemaVersion !== BCLIF_TILE_SCHEMA_VERSION
      || tile.schemaVersion !== Number(replacement.schema_version)
      || tile.tileVersion !== Number(replacement.tile_version)
      || tile.modelVersion !== String(replacement.model_version)
      || tile.horizon !== String(replacement.horizon)
      || tile.startTime !== Date.parse(String(replacement.chunk_start))
      || tile.endTime !== Date.parse(String(replacement.chunk_end))
      || tile.sourceCutoffTimestamp !== Date.parse(String(replacement.source_cutoff_at))
      || tile.minPrice !== Number(replacement.price_min)
      || tile.maxPrice !== Number(replacement.price_max)
      || tile.priceStep !== Number(replacement.price_step)
      || tile.rows !== Number(replacement.rows)
      || tile.timeStepMs !== Number(replacement.time_step_ms)
      || tile.authority !== String(replacement.model_authority)
      || tile.authority !== "PERSISTENT_NODE"
    ) throw coded("REPLACEMENT_TILE_SCOPE_INVALID");
    assertReplacementCoversSupersededTile(source, replacement);
  }

  private async tileById(id: string) {
    const result = await this.supabase.from("bclif_field_chunks")
      .select("id,source_id,publication_state,object_path,checksum,schema_version,tile_version,model_version,horizon,chunk_start,chunk_end,source_cutoff_at,price_min,price_max,price_step,rows,time_step_ms,model_authority")
      .eq("id", id).limit(2);
    if (result.error) throw result.error;
    if ((result.data || []).length > 1) throw coded("TILE_IDENTITY_AMBIGUOUS");
    return result.data?.[0] || null;
  }

  private async tileByPath(path: string) {
    const result = await this.supabase.from("bclif_field_chunks")
      .select("id,source_id,publication_state,object_path,checksum,schema_version,tile_version,model_version,horizon,chunk_start,chunk_end,source_cutoff_at,price_min,price_max,price_step,rows,time_step_ms,model_authority")
      .eq("source_id", this.sourceId).eq("object_path", path).limit(2);
    if (result.error) throw result.error;
    if ((result.data || []).length > 1) throw coded("TILE_PATH_AMBIGUOUS");
    return result.data?.[0] || null;
  }
}

export function assertReplacementCoversSupersededTile(source: any, replacement: any) {
  const sameTextFields = ["source_id", "model_version", "model_authority"] as const;
  const sameNumericFields = ["schema_version", "tile_version", "price_min", "price_max", "price_step", "rows"] as const;
  if (!source || !replacement) throw coded("REPLACEMENT_TILE_SCOPE_INVALID");
  if (String(source.id) === String(replacement.id) || String(source.object_path) === String(replacement.object_path)) {
    throw coded("REPLACEMENT_TILE_IDENTITY_INVALID");
  }
  for (const field of sameTextFields) if (String(source[field]) !== String(replacement[field])) throw coded("REPLACEMENT_TILE_SCOPE_INVALID");
  for (const field of sameNumericFields) if (Number(source[field]) !== Number(replacement[field])) throw coded("REPLACEMENT_TILE_SCOPE_INVALID");
  const sourceHorizon = String(source.horizon);
  const replacementHorizon = String(replacement.horizon);
  const sourceTimeStep = Number(source.time_step_ms);
  const replacementTimeStep = Number(replacement.time_step_ms);
  const rollupFactors: Record<string, number> = { "12H": 2, "1D": 4, "3D": 12, "1W": 28, "3W": 84, "1M": 120 };
  const sameResolution = sourceHorizon === replacementHorizon && sourceTimeStep === replacementTimeStep;
  const deterministicRollup = sourceHorizon === "6H"
    && Number.isFinite(sourceTimeStep)
    && replacementTimeStep === sourceTimeStep * (rollupFactors[replacementHorizon] ?? 0);
  if (!sameResolution && !deterministicRollup) throw coded("REPLACEMENT_TILE_SCOPE_INVALID");
  const sourceStart = Date.parse(String(source.chunk_start));
  const sourceEnd = Date.parse(String(source.chunk_end));
  const sourceCutoff = Date.parse(String(source.source_cutoff_at));
  const replacementStart = Date.parse(String(replacement.chunk_start));
  const replacementEnd = Date.parse(String(replacement.chunk_end));
  const replacementCutoff = Date.parse(String(replacement.source_cutoff_at));
  if (
    ![sourceStart, sourceEnd, sourceCutoff, replacementStart, replacementEnd, replacementCutoff].every(Number.isFinite)
    || replacementStart > sourceStart
    || replacementEnd < sourceEnd
    || replacementCutoff < sourceCutoff
  ) throw coded("REPLACEMENT_TILE_COVERAGE_INVALID");
}

function coded(code: string) { return Object.assign(new Error(code), { code }); }
function safeCode(error: unknown) {
  const value = String((error as { code?: unknown })?.code || (error instanceof Error ? error.message : "RETENTION_ERROR"));
  return value.replace(/[^A-Z0-9_]/gi, "_").slice(0, 64).toUpperCase();
}
function isUniqueViolation(error: any) { return String(error?.code || "") === "23505"; }
