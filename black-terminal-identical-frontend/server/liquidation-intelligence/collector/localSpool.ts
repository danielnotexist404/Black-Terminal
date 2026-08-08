import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BclifCanonicalEvent } from "../contracts.ts";
import { canonicalJson } from "../normalization/canonicalEnvelope.ts";

const MAX_EVENT_BYTES = 2 * 1024 * 1024;

/**
 * Bounded crash journal for canonical events awaiting immutable object + DB
 * publication. One deterministic file per dedup identity makes reconnect
 * overlap naturally idempotent. Files are fsynced before ingestion proceeds.
 */
export class BclifLocalEventSpool {
  private initialized = false;
  private bytes = 0;
  private readonly directory: string;
  private readonly quota: BclifSpoolQuota;

  constructor(rootDirectory: string, symbol: string, quota: BclifSpoolQuota) {
    if (!/^[A-Z0-9_-]{2,40}$/.test(symbol)) throw new Error("Invalid BCLIF spool symbol");
    this.directory = join(rootDirectory, symbol);
    this.quota = quota;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".json")) total += (await stat(join(this.directory, entry.name))).size;
    this.bytes = total;
    this.initialized = true;
    return { files: entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length, bytes: total };
  }

  async put(events: readonly BclifCanonicalEvent[]) {
    this.requireInitialized();
    const staged = events.map((event) => ({ event, bytes: Buffer.from(canonicalJson(event), "utf8"), path: this.path(event) }));
    for (const item of staged) if (item.bytes.byteLength > MAX_EVENT_BYTES) throw new Error("BCLIF canonical event exceeds spool record bound");
    const absent: typeof staged = [];
    for (const item of staged) {
      try {
        await stat(item.path);
        const existing = await readFile(item.path);
        if (!existing.equals(item.bytes)) throw new Error("BCLIF spool identity collision has different canonical bytes");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        absent.push(item);
      }
    }
    const requiredBytes = absent.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    this.quota.reserve(requiredBytes);
    let writtenBytes = 0;
    try {
      for (const item of absent) {
        const temporary = `${item.path}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(item.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, item.path);
        writtenBytes += item.bytes.byteLength;
        this.bytes += item.bytes.byteLength;
      }
    } catch (error) {
      this.quota.release(requiredBytes - writtenBytes);
      throw error;
    }
    if (absent.length) await syncDirectory(this.directory);
    return absent.length;
  }

  async recover() {
    this.requireInitialized();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const events: BclifCanonicalEvent[] = [];
    for (const name of names) {
      const bytes = await readFile(join(this.directory, name));
      if (!bytes.byteLength || bytes.byteLength > MAX_EVENT_BYTES) throw new Error(`Corrupt BCLIF spool record ${name}`);
      const event = JSON.parse(bytes.toString("utf8")) as BclifCanonicalEvent;
      if (event?.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(event.dedupKey) || this.filename(event) !== name) {
        throw new Error(`Corrupt BCLIF spool identity ${name}`);
      }
      events.push(event);
    }
    return events.sort((a, b) => Math.max(a.exchangeTimestamp, a.receivedTimestamp) - Math.max(b.exchangeTimestamp, b.receivedTimestamp) || a.eventId.localeCompare(b.eventId));
  }

  async acknowledge(events: readonly BclifCanonicalEvent[]) {
    this.requireInitialized();
    let removed = 0;
    for (const event of events) {
      const path = this.path(event);
      try {
        const size = (await stat(path)).size;
        await unlink(path);
        this.bytes = Math.max(0, this.bytes - size);
        this.quota.release(size);
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (removed) await syncDirectory(this.directory);
    return removed;
  }

  usage() { return { symbolBytes: this.bytes, ...this.quota.usage() }; }

  private filename(event: Pick<BclifCanonicalEvent, "kind" | "dedupKey">) {
    const digest = event.dedupKey.replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid BCLIF spool dedup key");
    return `${event.kind}-${digest}.json`;
  }
  private path(event: Pick<BclifCanonicalEvent, "kind" | "dedupKey">) { return join(this.directory, this.filename(event)); }
  private requireInitialized() { if (!this.initialized) throw new Error("BCLIF spool is not initialized"); }
}

/** One quota is shared by every symbol spool in the collector process. */
export class BclifSpoolQuota {
  private usedBytes = 0;
  private readonly maximumBytes: number;
  private constructor(maximumBytes: number) {
    this.maximumBytes = maximumBytes;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < MAX_EVENT_BYTES) throw new Error("Invalid BCLIF process spool byte cap");
  }

  static async create(rootDirectory: string, maximumBytes: number) {
    const quota = new BclifSpoolQuota(maximumBytes);
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    quota.usedBytes = await cleanAndMeasure(rootDirectory);
    if (quota.usedBytes > maximumBytes) throw spoolFull(quota.usedBytes, maximumBytes);
    return quota;
  }

  reserve(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid BCLIF spool reservation");
    if (this.usedBytes + bytes > this.maximumBytes) throw spoolFull(this.usedBytes + bytes, this.maximumBytes);
    this.usedBytes += bytes;
  }
  release(bytes: number) { this.usedBytes = Math.max(0, this.usedBytes - Math.max(0, bytes)); }
  usage() { return { bytes: this.usedBytes, maximumBytes: this.maximumBytes, ratio: this.usedBytes / this.maximumBytes }; }
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function spoolFull(required: number, maximum: number) {
  return Object.assign(new Error(`BCLIF spool capacity exceeded (${required}/${maximum} bytes)`), { code: "BCLIF_SPOOL_FULL" });
}

async function cleanAndMeasure(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await cleanAndMeasure(path);
    else if (entry.isFile() && entry.name.endsWith(".tmp")) await unlink(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}
