import { BybitBookReconstructor, BYBIT_RECONSTRUCTION_STATES } from "../market-depth/bybit-book-reconstructor.js";
import { HistoricalFrameChunkWriter } from "./frame-chunk-store.js";

const BYBIT_LINEAR_WS = "wss://stream.bybit.com/v5/public/linear";

export class HistoricalLiquidityCollector {
  constructor({ supabase, symbol = "BTCUSDT", logger = console, reconnectBaseMs = 1_500 } = {}) {
    if (!supabase) throw new Error("HistoricalLiquidityCollector requires Supabase admin access.");
    this.supabase = supabase;
    this.symbol = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, "");
    this.logger = logger;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconstructor = new BybitBookReconstructor({ symbol: this.symbol, depth: 1_000, persistCadenceMs: 1_000 });
    this.storage = new HistoricalFrameChunkWriter({ supabase, venue: "bybit", marketKind: "perpetual", symbol: this.symbol });
    this.ws = null;
    this.running = false;
    this.reconnectTimer = null;
    this.reconnects = 0;
    this.lastMessageAt = null;
    this.lastPersistAt = null;
    this.persistedFrames = 0;
    this.rejectedUpdates = 0;
    this.lastError = null;
  }

  start() {
    if (this.running) return;
    if (typeof WebSocket !== "function") throw new Error("Historical liquidity collection requires WebSocket support.");
    this.running = true;
    void this.storage.setState(BYBIT_RECONSTRUCTION_STATES.STARTING, this.reconstructor.diagnostics());
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.ws?.close(); } catch { /* best effort */ }
    this.ws = null;
  }

  diagnostics() {
    const book = this.reconstructor.diagnostics();
    return {
      venue: "bybit", marketKind: "perpetual", symbol: this.symbol,
      status: this.ws?.readyState === 1 ? "open" : book.state === BYBIT_RECONSTRUCTION_STATES.FAILED ? "error" : "connecting",
      reconnects: this.reconnects, lastMessageAt: this.lastMessageAt, lastPersistAt: this.lastPersistAt,
      messageCount: book.snapshotCount + book.deltaCount, sampleCount: this.persistedFrames, ingestCount: this.persistedFrames,
      packetLossCount: book.gapCount, snapshotRecoveryCount: Math.max(0, book.snapshotCount - 1),
      snapshotRebuildCount: book.snapshotCount, invalidBookCount: book.gapCount,
      rejectedUpdateCount: this.rejectedUpdates, duplicateUpdateCount: 0,
      lastSnapshotAt: book.snapshotCount ? book.lastSourceTimestamp : null,
      lastIntegrityFailureAt: book.gapCount ? book.lastSourceTimestamp : null,
      lastSequence: book.lastUpdateId, reconstructionState: book.state, lastError: this.lastError || book.lastError
    };
  }

  connect() {
    if (!this.running) return;
    this.reconstructor.connected();
    void this.storage.setState(BYBIT_RECONSTRUCTION_STATES.SNAPSHOT_LOADING, this.reconstructor.diagnostics());
    const ws = new WebSocket(BYBIT_LINEAR_WS);
    this.ws = ws;
    ws.onopen = () => {
      this.lastError = null;
      ws.send(JSON.stringify({ op: "subscribe", args: [`orderbook.1000.${this.symbol}`] }));
      this.logger.info?.(`[BookHeatmapCollector] subscribed orderbook.1000.${this.symbol}`);
    };
    ws.onmessage = (event) => void this.handleMessage(event.data);
    ws.onerror = () => { this.lastError = "Bybit WebSocket transport error."; };
    ws.onclose = () => this.scheduleReconnect();
  }

  async handleMessage(raw) {
    try {
      const payload = JSON.parse(String(raw));
      if (!payload?.topic?.startsWith("orderbook.")) return;
      this.lastMessageAt = Date.now();
      const result = this.reconstructor.ingest(payload, this.lastMessageAt);
      if (result.gapDetected) {
        this.rejectedUpdates += 1;
        this.lastError = `Depth integrity lost: ${result.reason}`;
        await this.storage.setState(BYBIT_RECONSTRUCTION_STATES.GAP_DETECTED, this.reconstructor.diagnostics()).catch(() => null);
        this.reconstructor.resyncing();
        await this.storage.setState(BYBIT_RECONSTRUCTION_STATES.RESYNCING, this.reconstructor.diagnostics()).catch(() => null);
        this.ws?.close(1012, "sequence resynchronization");
        return;
      }
      if (!result.accepted || !result.frame) return;
      await this.storage.append(result.frame);
      this.persistedFrames += 1;
      this.lastPersistAt = Date.now();
    } catch (error) {
      this.rejectedUpdates += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error?.("[BookHeatmapCollector] frame rejected", error);
      await this.storage.setState(BYBIT_RECONSTRUCTION_STATES.DEGRADED, this.reconstructor.diagnostics()).catch(() => null);
      this.reconstructor.resyncing();
      this.ws?.close(1012, "invalid depth frame");
    }
  }

  scheduleReconnect() {
    this.ws = null;
    if (!this.running || this.reconnectTimer) return;
    this.reconnects += 1;
    const delay = Math.min(60_000, this.reconnectBaseMs * Math.max(1, this.reconnects));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
