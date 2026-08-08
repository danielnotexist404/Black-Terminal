import type { BclifCanonicalEvent, BclifWriterFence, PersistentLiquidationEvent } from "../contracts.ts";
import { validateWriterFence, writerFenceColumns } from "./writerFence.ts";

export class BclifConfirmedLiquidationRepository {
  private readonly supabase: any;
  private readonly sourceId: string;
  private readonly fence: BclifWriterFence;
  constructor(supabase: any, sourceId: string, fence: BclifWriterFence) { this.supabase = supabase; this.sourceId = sourceId; this.fence = validateWriterFence(fence); }

  async persist(events: readonly BclifCanonicalEvent<PersistentLiquidationEvent>[]) {
    if (!events.length) return 0;
    const rows = events.map((event) => ({
      source_id: this.sourceId,
      venue_event_id: event.payload.id,
      event_time: new Date(event.exchangeTimestamp).toISOString(),
      received_at: new Date(event.receivedTimestamp).toISOString(),
      liquidated_position_side: event.payload.liquidatedSide,
      quantity: event.payload.quantity,
      bankruptcy_price: event.payload.bankruptcyPrice,
      notional: event.payload.estimatedNotional,
      certainty: "OBSERVED",
      source_version: event.sourceVersion,
      event_checksum: event.dedupKey,
      source_payload: event.payload,
      ...writerFenceColumns(this.fence)
    }));
    const result = await this.supabase.from("bclif_confirmed_liquidation_events")
      .upsert(rows, { onConflict: "source_id,event_checksum", ignoreDuplicates: true })
      .select("id");
    if (result.error) throw result.error;
    return result.data?.length ?? 0;
  }
}
