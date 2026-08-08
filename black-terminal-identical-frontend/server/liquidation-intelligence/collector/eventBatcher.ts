import type { BclifCanonicalEvent, BclifCanonicalEventKind } from "../contracts.ts";
import { canonicalJson } from "../normalization/canonicalEnvelope.ts";
import type { BclifEventChunkRepository } from "../state/eventChunkRepository.ts";
import type { BclifEventDeduplicator } from "../state/eventDeduplication.ts";

const PERSISTED_KINDS = new Set<BclifCanonicalEventKind>(["TRADE", "LIQUIDATION", "OPEN_INTEREST", "BOOK_FRAME", "FUNDING", "MARK_INDEX", "POSITION_RATIO", "RISK_TIER", "INSTRUMENT_INFO"]);

export class BclifEventBatcher {
  private readonly batches = new Map<BclifCanonicalEventKind, { events: BclifCanonicalEvent[]; bytes: number; openedAt: number }>();
  private writeChain = Promise.resolve();
  private inFlightBytes = 0;
  private lastError: unknown = null;
  private readonly repository: BclifEventChunkRepository;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly deduplicator: BclifEventDeduplicator | null;
  private readonly maximumPendingBytes: number;
  private readonly onPersisted: ((events: readonly BclifCanonicalEvent[]) => Promise<void>) | null;

  constructor(
    repository: BclifEventChunkRepository,
    maxBytes: number,
    maxAgeMs: number,
    deduplicator: BclifEventDeduplicator | null = null,
    options: { maximumPendingBytes?: number; onPersisted?: (events: readonly BclifCanonicalEvent[]) => Promise<void> } = {}
  ) {
    this.repository = repository;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.deduplicator = deduplicator;
    this.maximumPendingBytes = Math.max(maxBytes, options.maximumPendingBytes ?? maxBytes * 8);
    this.onPersisted = options.onPersisted ?? null;
  }

  add(events: readonly BclifCanonicalEvent[], now = Date.now()) {
    const persistable = events.filter((event) => PERSISTED_KINDS.has(event.kind));
    const incomingBytes = persistable.reduce((sum, event) => sum + Buffer.byteLength(canonicalJson(event), "utf8") + 1, 0);
    if (this.bufferedBytes() + incomingBytes > this.maximumPendingBytes) {
      throw Object.assign(new Error("BCLIF event batcher reached its hard backpressure bound"), { code: "BCLIF_BATCH_BACKPRESSURE" });
    }
    for (const event of persistable) {
      const batch = this.batches.get(event.kind) || { events: [], bytes: 0, openedAt: now };
      batch.events.push(event);
      batch.bytes += Buffer.byteLength(canonicalJson(event), "utf8") + 1;
      this.batches.set(event.kind, batch);
      if (batch.bytes >= this.maxBytes) this.enqueueFlush(event.kind);
    }
  }

  flushAged(now = Date.now()) {
    for (const [kind, batch] of this.batches) if (batch.events.length && now - batch.openedAt >= this.maxAgeMs) this.enqueueFlush(kind);
    return this.writeChain;
  }

  async drain() {
    for (const kind of [...this.batches.keys()]) this.enqueueFlush(kind);
    await this.writeChain;
    if (this.lastError) {
      const error = this.lastError;
      this.lastError = null;
      throw error;
    }
  }

  pendingEvents() { return [...this.batches.values()].reduce((sum, batch) => sum + batch.events.length, 0); }
  pendingBytes() { return [...this.batches.values()].reduce((sum, batch) => sum + batch.bytes, 0); }
  bufferedBytes() { return this.pendingBytes() + this.inFlightBytes; }

  private enqueueFlush(kind: BclifCanonicalEventKind) {
    const batch = this.batches.get(kind);
    if (!batch?.events.length) return;
    this.batches.set(kind, { events: [], bytes: 0, openedAt: Date.now() });
    const events = batch.events;
    this.inFlightBytes += batch.bytes;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        let published = false;
        try {
          await this.repository.publish(kind, events);
          published = true;
          await this.deduplicator?.commit(events);
          await this.onPersisted?.(events);
          this.inFlightBytes = Math.max(0, this.inFlightBytes - batch.bytes);
        } catch (error) {
          // Never republish a chunk after object+metadata publication succeeded.
          // The durable spool retains those records until dedup/ack recovery.
          if (!published) {
            const pending = this.batches.get(kind) || { events: [], bytes: 0, openedAt: Date.now() };
            pending.events.unshift(...events);
            pending.bytes += events.reduce((sum, event) => sum + Buffer.byteLength(canonicalJson(event), "utf8") + 1, 0);
            pending.openedAt = Math.min(pending.openedAt, batch.openedAt);
            this.batches.set(kind, pending);
          }
          this.inFlightBytes = Math.max(0, this.inFlightBytes - batch.bytes);
          this.lastError = error;
        }
      });
  }
}
