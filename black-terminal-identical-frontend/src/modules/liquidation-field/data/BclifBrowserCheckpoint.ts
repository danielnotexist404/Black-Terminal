import { LIQUIDATION_FIELD_SETTINGS_VERSION } from "../core/settings.ts";
import {
  BCLIF_MODEL_VERSION,
  type LiquidationFieldSettings,
  type LiquidationFieldSnapshot
} from "../core/types.ts";
import { bclifExposureHash } from "../rendering/displayProjection.ts";

export const BCLIF_BROWSER_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const BCLIF_BROWSER_CHECKPOINT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
export const BCLIF_BROWSER_CHECKPOINT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const BCLIF_BROWSER_CHECKPOINT_MAX_ENTRIES = 3;

export interface BclifBrowserCheckpointRecord {
  key: string;
  createdAt: number;
  bytes: number;
  checksum: string;
  modelVersion: string;
  rendererSchemaVersion: number;
  venue: string;
  symbol: string;
  horizon: string;
  presentationFamily: string;
  snapshot: LiquidationFieldSnapshot;
}

export interface BclifBrowserCheckpointAdapter {
  get(key: string): Promise<BclifBrowserCheckpointRecord | null>;
  list(): Promise<BclifBrowserCheckpointRecord[]>;
  put(record: BclifBrowserCheckpointRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export function bclifBrowserCheckpointKey(symbol: string, settings: LiquidationFieldSettings) {
  const normalizedSymbol = symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const presentationFamily = settings.preset === "RAW_MODEL" ? "RAW" : "THERMAL";
  return [
    "bclif-public", BCLIF_MODEL_VERSION, `renderer-v${LIQUIDATION_FIELD_SETTINGS_VERSION}`,
    settings.venue, normalizedSymbol, settings.horizon, presentationFamily
  ].join(":");
}

export function bclifSnapshotPublicByteSize(snapshot: LiquidationFieldSnapshot) {
  const typedBytes = [
    snapshot.timestamps, snapshot.longExposure, snapshot.shortExposure, snapshot.combinedExposure,
    snapshot.normalizedIntensity, snapshot.longNormalizedIntensity, snapshot.shortNormalizedIntensity,
    snapshot.confidence, snapshot.validity, snapshot.confirmedIntensity,
    snapshot.confirmedNotional, snapshot.confirmedCount
  ].reduce((sum, value) => sum + value.byteLength, 0);
  const sidecar = JSON.stringify({
    header: snapshot.header,
    cohorts: snapshot.cohorts,
    massLedger: snapshot.massLedger,
    lifecycleEvents: snapshot.lifecycleEvents,
    confirmedEvents: snapshot.confirmedEvents,
    cascade: snapshot.cascade,
    coverage: snapshot.coverage,
    persistentCoverage: snapshot.persistentCoverage ?? null,
    generations: snapshot.generations ?? null
  });
  return typedBytes + new TextEncoder().encode(sidecar).byteLength;
}

export class BclifBrowserCheckpointStore {
  private readonly adapter: BclifBrowserCheckpointAdapter;
  private readonly now: () => number;

  constructor(
    adapter: BclifBrowserCheckpointAdapter,
    now: () => number = Date.now
  ) {
    this.adapter = adapter;
    this.now = now;
  }

  async restore(symbol: string, settings: LiquidationFieldSettings) {
    const key = bclifBrowserCheckpointKey(symbol, settings);
    const record = await this.adapter.get(key);
    if (!record) return null;
    try {
      const actualBytes = bclifSnapshotPublicByteSize(record.snapshot);
      const normalizedSymbol = symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
      const compatible = record.modelVersion === BCLIF_MODEL_VERSION
        && record.rendererSchemaVersion === LIQUIDATION_FIELD_SETTINGS_VERSION
        && record.venue === settings.venue
        && record.symbol === normalizedSymbol
        && record.horizon === settings.horizon
        && record.snapshot.header.venue === settings.venue
        && record.snapshot.header.symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() === normalizedSymbol
        && record.snapshot.header.horizon === settings.horizon
        && record.snapshot.authority === "BROWSER_FALLBACK"
        && Number.isFinite(record.createdAt)
        && record.createdAt <= this.now()
        && this.now() - record.createdAt <= BCLIF_BROWSER_CHECKPOINT_MAX_AGE_MS
        && record.bytes === actualBytes
        && actualBytes <= BCLIF_BROWSER_CHECKPOINT_MAX_RECORD_BYTES;
      if (compatible && record.checksum === bclifExposureHash(record.snapshot)) {
        return record.snapshot;
      }
    } catch {
      // Corrupt public checkpoints must not poison each subsequent cold start.
    }
    await this.adapter.delete(key);
    return null;
  }

  async save(symbol: string, settings: LiquidationFieldSettings, snapshot: LiquidationFieldSnapshot) {
    if (snapshot.authority !== "BROWSER_FALLBACK" || snapshot.header.modelVersion !== BCLIF_MODEL_VERSION) return false;
    const key = bclifBrowserCheckpointKey(symbol, settings);
    const bytes = bclifSnapshotPublicByteSize(snapshot);
    if (bytes > BCLIF_BROWSER_CHECKPOINT_MAX_RECORD_BYTES) return false;
    const record: BclifBrowserCheckpointRecord = {
      key,
      createdAt: this.now(),
      bytes,
      checksum: bclifExposureHash(snapshot),
      modelVersion: snapshot.header.modelVersion,
      rendererSchemaVersion: LIQUIDATION_FIELD_SETTINGS_VERSION,
      venue: settings.venue,
      symbol: symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase(),
      horizon: settings.horizon,
      presentationFamily: settings.preset === "RAW_MODEL" ? "RAW" : "THERMAL",
      snapshot
    };
    await this.adapter.put(record);
    await this.prune();
    return true;
  }

  private async prune() {
    const now = this.now();
    const records = (await this.adapter.list()).sort((a, b) => b.createdAt - a.createdAt);
    let retained = 0;
    let bytes = 0;
    for (const record of records) {
      const expired = now - record.createdAt > BCLIF_BROWSER_CHECKPOINT_MAX_AGE_MS;
      const overBudget = retained >= BCLIF_BROWSER_CHECKPOINT_MAX_ENTRIES
        || bytes + record.bytes > BCLIF_BROWSER_CHECKPOINT_MAX_TOTAL_BYTES;
      if (expired || overBudget) {
        await this.adapter.delete(record.key);
        continue;
      }
      retained += 1;
      bytes += record.bytes;
    }
  }
}

const DATABASE_NAME = "black-terminal-bclif-public-v1";
const STORE_NAME = "public-checkpoints";

export class IndexedDbBclifCheckpointAdapter implements BclifBrowserCheckpointAdapter {
  private database: Promise<IDBDatabase> | null = null;

  async get(key: string) {
    const db = await this.open();
    return await request<BclifBrowserCheckpointRecord | undefined>(
      db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)
    ) ?? null;
  }

  async list() {
    const db = await this.open();
    return request<BclifBrowserCheckpointRecord[]>(
      db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()
    );
  }

  async put(record: BclifBrowserCheckpointRecord) {
    const db = await this.open();
    await transactionDone(db, "readwrite", (store) => store.put(record));
  }

  async delete(key: string) {
    const db = await this.open();
    await transactionDone(db, "readwrite", (store) => store.delete(key));
  }

  private open() {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const openRequest = indexedDB.open(DATABASE_NAME, 1);
      openRequest.onupgradeneeded = () => {
        if (!openRequest.result.objectStoreNames.contains(STORE_NAME)) {
          openRequest.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error ?? new Error("BCLIF_CHECKPOINT_OPEN_FAILED"));
    });
    return this.database;
  }
}

export function createBrowserCheckpointStore() {
  return typeof indexedDB === "undefined"
    ? null
    : new BclifBrowserCheckpointStore(new IndexedDbBclifCheckpointAdapter());
}

function request<T>(source: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("BCLIF_CHECKPOINT_REQUEST_FAILED"));
  });
}

function transactionDone(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest
) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    operation(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("BCLIF_CHECKPOINT_TRANSACTION_FAILED"));
    tx.onabort = () => reject(tx.error ?? new Error("BCLIF_CHECKPOINT_TRANSACTION_ABORTED"));
  });
}
