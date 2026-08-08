import type { BclifCohortCheckpointMetadata, BclifCohortCheckpointState, BclifWriterFence } from "../contracts.ts";
import { canonicalJson } from "../normalization/canonicalEnvelope.ts";
import { boundedGunzip, deterministicGzip } from "./eventChunkRepository.ts";
import { BclifObjectStore, objectSha256 } from "./objectStore.ts";
import { deterministicBclifTileId } from "../tiles/tileBuilder.ts";
import { BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE } from "./coverageRepository.ts";
import { validateWriterFence, writerFenceColumns } from "./writerFence.ts";

const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;

export class BclifCheckpointRepository {
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

  async save(state: BclifCohortCheckpointState, reason: BclifCohortCheckpointMetadata["reason"]) {
    validateCheckpointState(state);
    const raw = new TextEncoder().encode(canonicalJson(state));
    if (raw.byteLength > MAX_CHECKPOINT_BYTES) throw new Error("BCLIF checkpoint exceeds safety bound");
    const compressed = deterministicGzip(raw);
    const checksum = objectSha256(compressed);
    const checkpointId = deterministicBclifTileId({
      checksum,
      modelVersion: state.modelVersion,
      reason,
      sourceCutoffTimestamp: state.sourceCutoffTimestamp,
      sourceId: this.sourceId,
      sourceVersion: state.sourceVersion,
      symbol: state.symbol,
      timestamp: state.timestamp
    });
    const digest = checksum.slice("sha256:".length);
    const path = `checkpoints/v1/BYBIT/linear_perpetual/${state.symbol}/${state.timestamp}/${checkpointId}-${digest}.checkpoint.gz`;
    const existingBeforeUpload = await this.findExisting(checkpointId);
    if (existingBeforeUpload) return this.verifyExisting(existingBeforeUpload, checksum);
    try {
      await this.objectStore.upload(path, compressed, "checkpoint", "application/gzip");
    } catch (error) {
      try {
        const stored = await this.objectStore.download(path, "checkpoint");
        if (objectSha256(stored) !== checksum) throw new Error("BCLIF checkpoint conflicts with deterministic publication identity");
      } catch {
        const raced = await this.findExisting(checkpointId);
        if (raced) return this.verifyExisting(raced, checksum);
        throw error;
      }
    }
    const metadata: BclifCohortCheckpointMetadata = {
      checkpointId,
      venue: "BYBIT",
      symbol: state.symbol,
      modelVersion: state.modelVersion,
      sourceVersion: state.sourceVersion,
      timestamp: state.timestamp,
      sourceCutoffTimestamp: state.sourceCutoffTimestamp,
      cohortCount: state.cohortState.cohorts.length,
      particleCount: state.cohortState.particles.length,
      serializedStateLocation: path,
      checksum,
      compressedBytes: compressed.byteLength,
      createdByNodeId: this.nodeId,
      reason,
      ...writerFenceColumns(this.fence)
    };
    const result = await this.supabase.from("bclif_cohort_checkpoints").insert({
      checkpoint_id: checkpointId,
      source_id: this.sourceId,
      venue: "BYBIT",
      symbol: state.symbol,
      model_version: state.modelVersion,
      source_version: state.sourceVersion,
      schema_version: 1,
      checkpoint_at: new Date(state.timestamp).toISOString(),
      source_cutoff_at: new Date(state.sourceCutoffTimestamp).toISOString(),
      cohort_count: metadata.cohortCount,
      particle_count: metadata.particleCount,
      bucket_id: "bclif-field-chunks",
      object_path: path,
      checksum,
      compressed_bytes: compressed.byteLength,
      created_by_node_id: this.nodeId,
      reason,
      ...writerFenceColumns(this.fence)
    });
    if (result.error) {
      try {
        const existing = await this.findExisting(checkpointId);
        if (existing) return this.verifyExisting(existing, checksum);
      } catch {
        throw Object.assign(new Error("BCLIF checkpoint publication outcome is ambiguous; object preserved for recovery"), { cause: result.error });
      }
      await this.objectStore.remove(path, "checkpoint").catch(() => null);
      throw result.error;
    }
    return metadata;
  }

  private async findExisting(checkpointId: string) {
    const result = await this.supabase.from("bclif_cohort_checkpoints")
      .select("checkpoint_id,venue,symbol,model_version,source_version,checkpoint_at,source_cutoff_at,cohort_count,particle_count,object_path,checksum,compressed_bytes,created_by_node_id,reason")
      .eq("source_id", this.sourceId)
      .eq("checkpoint_id", checkpointId)
      .limit(2);
    if (result.error) throw result.error;
    const rows = result.data || [];
    if (rows.length > 1) throw new Error("BCLIF checkpoint identity resolved to multiple rows");
    return rows[0] || null;
  }

  private async verifyExisting(row: any, expectedChecksum: string): Promise<BclifCohortCheckpointMetadata> {
    if (String(row.checksum) !== expectedChecksum) throw new Error("BCLIF checkpoint retry checksum conflicts with immutable metadata");
    const bytes = await this.objectStore.download(String(row.object_path), "checkpoint");
    if (objectSha256(bytes) !== expectedChecksum) throw new Error("BCLIF checkpoint object checksum verification failed");
    return {
      checkpointId: String(row.checkpoint_id),
      venue: "BYBIT",
      symbol: String(row.symbol),
      modelVersion: String(row.model_version),
      sourceVersion: String(row.source_version),
      timestamp: Date.parse(String(row.checkpoint_at)),
      sourceCutoffTimestamp: Date.parse(String(row.source_cutoff_at)),
      cohortCount: Number(row.cohort_count),
      particleCount: Number(row.particle_count),
      serializedStateLocation: String(row.object_path),
      checksum: String(row.checksum),
      compressedBytes: Number(row.compressed_bytes),
      createdByNodeId: String(row.created_by_node_id),
      reason: row.reason
    };
  }

  async loadLatest(modelVersion: string, sourceVersion: string) {
    const result = await this.supabase.from("bclif_cohort_checkpoints")
      .select("checkpoint_id,model_version,source_version,schema_version,object_path,checksum,source_cutoff_at")
      .eq("source_id", this.sourceId)
      .eq("model_version", modelVersion)
      .order("source_cutoff_at", { ascending: false })
      .limit(10);
    if (result.error) throw result.error;
    const failures: Array<{ checkpointId: string; error: string }> = [];
    for (const row of result.data || []) {
      try {
        if (row.schema_version !== 1 || row.source_version !== sourceVersion) throw new Error("checkpoint schema/source version mismatch");
        const compressed = await this.objectStore.download(row.object_path, "checkpoint");
        if (objectSha256(compressed) !== row.checksum) throw new Error("checkpoint object checksum mismatch");
        const raw = boundedGunzip(compressed, MAX_CHECKPOINT_BYTES);
        const state = JSON.parse(new TextDecoder().decode(raw)) as BclifCohortCheckpointState;
        validateCheckpointState(state, modelVersion, sourceVersion);
        return { checkpointId: row.checkpoint_id as string, state, failures };
      } catch (error) {
        failures.push({ checkpointId: String(row.checkpoint_id), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { checkpointId: null, state: null, failures };
  }
}

export function validateCheckpointState(state: BclifCohortCheckpointState, modelVersion?: string, sourceVersion?: string) {
  if (state?.schemaVersion !== 1 || state.venue !== "BYBIT" || !/^[A-Z0-9]{3,30}$/.test(state.symbol)) throw new Error("Invalid BCLIF checkpoint envelope");
  if (modelVersion && state.modelVersion !== modelVersion) throw new Error("BCLIF checkpoint model version mismatch");
  if (sourceVersion && state.sourceVersion !== sourceVersion) throw new Error("BCLIF checkpoint source version mismatch");
  if (!Number.isFinite(state.timestamp) || !Number.isFinite(state.sourceCutoffTimestamp) || state.sourceCutoffTimestamp > state.timestamp) {
    throw new Error("Invalid BCLIF checkpoint clock");
  }
  if (!state.cohortState || !Array.isArray(state.cohortState.cohorts) || !Array.isArray(state.cohortState.particles)) throw new Error("Invalid BCLIF checkpoint cohort state");
  if (!state.instrumentRules || state.instrumentRules.venue !== "BYBIT" || state.instrumentRules.symbol !== state.symbol || state.instrumentRules.sourceVersion !== state.sourceVersion || !Array.isArray(state.instrumentRules.riskTiers)) {
    throw new Error("Invalid BCLIF checkpoint point-in-time instrument rules");
  }
  if (!("lastConsumedOpenInterest" in state)) throw new Error("BCLIF checkpoint is missing its consumed OI cursor");
  if (state.lastConsumedOpenInterest) {
    const point = state.lastConsumedOpenInterest;
    if (point.availabilityMode !== "LIVE_OBSERVATION" || point.sourceVersion !== state.sourceVersion || !Number.isFinite(point.timestamp) || !Number.isFinite(point.availableAt) || point.availableAt !== point.receivedTimestamp || point.availableAt > state.sourceCutoffTimestamp || point.timestamp > state.sourceCutoffTimestamp || !(point.singleSideOpenInterest > 0)) {
      throw new Error("Invalid BCLIF checkpoint consumed OI cursor");
    }
  }
  if (!Array.isArray(state.sourceOffsets) || !Array.isArray(state.processedEventIds) || state.processedEventIds.length > 2_000_000) {
    throw new Error("Invalid BCLIF checkpoint recovery state");
  }
  if (state.confirmedIntensityState) {
    const value = state.confirmedIntensityState;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.maximumSamples) || value.maximumSamples < 64 || value.maximumSamples > 100_000 || value.recentLogNotionals.length > value.maximumSamples || !(value.lastScale > 0) || (value.lastProcessedKnownAt !== null && !Number.isFinite(value.lastProcessedKnownAt))) {
      throw new Error("Invalid BCLIF checkpoint confirmed-intensity state");
    }
  }
  if (state.activeTile) {
    const active = state.activeTile;
    if (!Number.isSafeInteger(active.rows) || active.rows < 1 || active.rows > 1_024 || !Array.isArray(active.columns) || active.columns.length > 4_096) {
      throw new Error("Invalid BCLIF active-tile checkpoint dimensions");
    }
    for (const column of active.columns) {
      for (const channel of [column.longExposure, column.shortExposure, column.combinedExposure, column.confidence, column.validity, column.confirmedIntensity, column.confirmedNotional, column.confirmedCount]) {
        if (!Array.isArray(channel) || channel.length !== active.rows || channel.some((value) => !Number.isFinite(value))) throw new Error("Invalid BCLIF active-tile checkpoint channel");
      }
      if (column.confirmedCount.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 65_535)) throw new Error("Invalid BCLIF active-tile confirmed count");
    }
  }
  if (state.coverageIntervals) {
    for (const [source, intervals] of Object.entries(state.coverageIntervals)) {
      if (!["TRADE", "LIQUIDATION", "OPEN_INTEREST", "BOOK_FRAME", "FUNDING"].includes(source) || !Array.isArray(intervals) || intervals.length > BCLIF_MAX_COVERAGE_INTERVALS_PER_SOURCE) {
        throw new Error("Invalid BCLIF checkpoint coverage state");
      }
      for (const interval of intervals) if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) {
        throw new Error("Invalid BCLIF checkpoint coverage interval");
      }
    }
  }
  return state;
}
