import type { BclifSourceOffset, BclifWriterFence } from "../contracts.ts";
import { validateWriterFence, writerFenceColumns } from "./writerFence.ts";

export class BclifSourceOffsetRepository {
  private readonly symbol: string;
  private readonly supabase: any;
  private readonly sourceId: string;
  private readonly sourceVersion: string;
  private readonly fence: BclifWriterFence;

  constructor(supabase: any, sourceId: string, sourceVersion: string, symbol: string, fence: BclifWriterFence) {
    this.supabase = supabase;
    this.sourceId = sourceId;
    this.sourceVersion = sourceVersion;
    this.symbol = String(symbol).trim().toUpperCase();
    this.fence = validateWriterFence(fence);
    if (!/^[A-Z0-9_-]{2,40}$/.test(this.symbol)) throw new Error("Invalid BCLIF source-offset symbol");
  }

  async load() {
    const result = await this.supabase.from("bclif_source_offsets")
      .select("source_name,source_partition,source_version,last_exchange_timestamp,last_received_timestamp,last_event_id,last_sequence,continuity_state,gap_count,reconnect_count,safe_metadata,updated_at")
      .eq("source_id", this.sourceId);
    if (result.error) throw result.error;
    return (result.data || []).map((row: any): BclifSourceOffset => ({
      sourceId: this.sourceId,
      venue: "BYBIT",
      symbol: this.symbol,
      source: row.source_name,
      sourceVersion: String(row.source_version),
      lastExchangeTimestamp: row.last_exchange_timestamp ? Date.parse(row.last_exchange_timestamp) : null,
      lastReceivedTimestamp: row.last_received_timestamp ? Date.parse(row.last_received_timestamp) : null,
      lastSequence: row.last_sequence,
      lastEventId: row.last_event_id,
      continuityStartedAt: finiteTimestampOrNull(row.safe_metadata?.continuityStartedAt),
      continuityState: row.continuity_state,
      gapCount: Number(row.gap_count) || 0,
      reconnectCount: Number(row.reconnect_count) || 0,
      safeMetadata: row.safe_metadata && typeof row.safe_metadata === "object" ? { ...row.safe_metadata } : {},
      updatedAt: Date.parse(row.updated_at)
    }));
  }

  async save(offset: BclifSourceOffset, partition = "default") {
    if (offset.symbol !== this.symbol || offset.sourceVersion !== this.sourceVersion) throw new Error("BCLIF source-offset identity mismatch");
    const result = await this.supabase.from("bclif_source_offsets").upsert({
      source_id: this.sourceId,
      source_name: offset.source,
      source_partition: partition,
      source_version: this.sourceVersion,
      last_exchange_timestamp: optionalIso(offset.lastExchangeTimestamp),
      last_received_timestamp: optionalIso(offset.lastReceivedTimestamp),
      last_event_id: offset.lastEventId,
      last_sequence: offset.lastSequence,
      continuity_state: offset.continuityState,
      gap_count: offset.gapCount,
      reconnect_count: offset.reconnectCount,
      safe_metadata: { ...offset.safeMetadata, continuityStartedAt: offset.continuityStartedAt },
      ...writerFenceColumns(this.fence)
    }, { onConflict: "source_id,source_name,source_partition" });
    if (result.error) throw result.error;
  }
}

function optionalIso(value: number | null) { return value === null ? null : new Date(value).toISOString(); }
function finiteTimestampOrNull(value: unknown) { const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? numeric : null; }
