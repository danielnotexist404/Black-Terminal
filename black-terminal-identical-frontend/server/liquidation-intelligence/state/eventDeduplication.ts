import type { BclifCanonicalEvent, BclifWriterFence } from "../contracts.ts";
import { validateWriterFence, writerFenceColumns } from "./writerFence.ts";

export class BclifEventDeduplicator {
  private readonly hot = new Map<string, number>();
  private readonly supabase: any;
  private readonly sourceId: string;
  private readonly windowMs: number;
  private readonly fence: BclifWriterFence;

  constructor(supabase: any, sourceId: string, windowMs: number, fence: BclifWriterFence) {
    this.supabase = supabase;
    this.sourceId = sourceId;
    this.windowMs = windowMs;
    this.fence = validateWriterFence(fence);
  }

  async accept(events: BclifCanonicalEvent[], now = Date.now()) {
    const accepted = await this.filterNew(events, now);
    await this.commit(accepted, now);
    return accepted;
  }

  async filterNew(events: readonly BclifCanonicalEvent[], now = Date.now(), markHot = true) {
    this.pruneHot(now);
    // Looking up durable duplicates must be side-effect free until the caller
    // has made its own durability boundary (the local fsync spool for live
    // ingestion). Otherwise a failed spool write poisons the hot cache and a
    // retry is silently discarded despite never having been persisted.
    const candidates = this.filterHot(events, now, false);
    if (!candidates.length) return [];
    const existing = new Set<string>();
    for (const kind of [...new Set(candidates.map((event) => event.kind))]) {
      const keys = candidates.filter((event) => event.kind === kind).map((event) => event.dedupKey);
      for (let offset = 0; offset < keys.length; offset += 500) {
        const result = await this.supabase.from("bclif_event_deduplication")
          .select("event_kind,dedup_key")
          .eq("source_id", this.sourceId)
          .eq("event_kind", kind)
          .in("dedup_key", keys.slice(offset, offset + 500));
        if (result.error) throw result.error;
        for (const row of result.data || []) existing.add(`${row.event_kind}:${row.dedup_key}`);
      }
    }
    const accepted = candidates.filter((event) => !existing.has(`${event.kind}:${event.dedupKey}`));
    if (markHot) for (const event of accepted) this.hot.set(`${event.kind}:${event.dedupKey}`, now + this.windowMs);
    return accepted;
  }

  filterHot(events: readonly BclifCanonicalEvent[], now = Date.now(), markHot = true) {
    this.pruneHot(now);
    const unique = new Map<string, BclifCanonicalEvent>();
    for (const event of events) {
      const key = `${event.kind}:${event.dedupKey}`;
      if (!this.hot.has(key) && !unique.has(key)) unique.set(key, event);
    }
    const accepted = [...unique.values()];
    if (markHot) for (const event of accepted) this.hot.set(`${event.kind}:${event.dedupKey}`, now + this.windowMs);
    return accepted;
  }

  async hydrate(now = Date.now(), limit = 200_000) {
    const result = await this.supabase.from("bclif_event_deduplication")
      .select("event_kind,dedup_key,expires_at")
      .eq("source_id", this.sourceId)
      .gt("expires_at", new Date(now).toISOString())
      .order("expires_at", { ascending: false })
      .limit(Math.max(1, Math.min(500_000, limit)));
    if (result.error) throw result.error;
    for (const row of result.data || []) {
      const expiresAt = Date.parse(row.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt > now) this.hot.set(`${row.event_kind}:${row.dedup_key}`, expiresAt);
    }
    return result.data?.length ?? 0;
  }

  async commit(events: readonly BclifCanonicalEvent[], now = Date.now()) {
    if (!events.length) return;
    const rows = events.map((event) => ({
      source_id: this.sourceId,
      event_kind: event.kind,
      dedup_key: event.dedupKey,
      exchange_timestamp: new Date(event.exchangeTimestamp).toISOString(),
      first_seen_at: new Date(event.receivedTimestamp).toISOString(),
      last_seen_at: new Date(event.receivedTimestamp).toISOString(),
      duplicate_count: 0,
      expires_at: new Date(Math.max(event.exchangeTimestamp + 1, now + this.windowMs)).toISOString(),
      ...writerFenceColumns(this.fence)
    }));
    const result = await this.supabase.from("bclif_event_deduplication")
      .upsert(rows, { onConflict: "source_id,event_kind,dedup_key", ignoreDuplicates: true })
      .select("event_kind,dedup_key");
    if (result.error) throw result.error;
  }

  seed(events: Array<Pick<BclifCanonicalEvent, "kind" | "dedupKey">>, now = Date.now()) {
    for (const event of events) this.hot.set(`${event.kind}:${event.dedupKey}`, now + this.windowMs);
  }

  async pruneExpired(now = Date.now()) {
    const result = await this.supabase.from("bclif_event_deduplication").delete({ count: "exact" }).lt("expires_at", new Date(now).toISOString());
    if (result.error) throw result.error;
    return result.count ?? 0;
  }

  private pruneHot(now: number) {
    for (const [key, expiresAt] of this.hot) if (expiresAt <= now) this.hot.delete(key);
  }
}
