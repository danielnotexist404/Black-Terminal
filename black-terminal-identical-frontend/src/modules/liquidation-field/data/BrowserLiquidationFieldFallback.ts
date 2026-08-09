import type { Candle } from "../../../chart-engine/types.ts";
import type {
  BclifAbsolutePriceGrid,
  LiquidationFieldRuntimeStatus,
  LiquidationFieldSettings,
  LiquidationFieldSnapshot,
  LiquidationMarketFrame
} from "../core/types.ts";
import { stableBrowserPriceGrid } from "../core/exposureRaster.ts";
import { liquidationFieldModelSettingsKey, migrateLiquidationFieldSettings } from "../core/settings.ts";
import { LiquidationFieldWorkerClient } from "../worker/LiquidationFieldWorkerClient.ts";
import { bootstrapBybitLiquidationField, type BybitLiquidationBootstrap } from "./bybitPublicData.ts";
import { BybitLiquidationStream, type BybitLiquidationLiveState } from "./bybitLiquidationStream.ts";
import { createBrowserCheckpointStore, type BclifBrowserCheckpointStore } from "./BclifBrowserCheckpoint.ts";


export interface BrowserLiquidationFieldFallbackOptions {
  symbol: string;
  settings: LiquidationFieldSettings;
  getCandles: () => Candle[];
  onSnapshot: (snapshot: LiquidationFieldSnapshot | null) => void;
  onStatus: (status: LiquidationFieldRuntimeStatus) => void;
  checkpointStore?: BclifBrowserCheckpointStore | null;
}

type BclifBuildTask = () => Promise<void>;

/**
 * Collapses any number of live updates received during an expensive model build
 * into one follow-up build. A completed first snapshot can therefore never be
 * invalidated forever by a faster public stream.
 */
export class BclifSingleFlightBuildGate {
  private inFlight: Promise<void> | null = null;
  private queued = false;
  private latestTask: BclifBuildTask | null = null;

  run(task: BclifBuildTask) {
    this.latestTask = task;
    if (this.inFlight) {
      this.queued = true;
      return this.inFlight;
    }
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain() {
    do {
      this.queued = false;
      const task = this.latestTask;
      if (task) await task();
    } while (this.queued);
  }
}

/**
 * Explicitly session-scoped browser model. The controller starts this class
 * only after the persistent authority has returned a fallback-safe result.
 * It never consumes or merges a persistent tile.
 */
export class BrowserLiquidationFieldFallback {
  private readonly options: BrowserLiquidationFieldFallbackOptions;
  private settings: LiquidationFieldSettings;
  private readonly worker = new LiquidationFieldWorkerClient();
  private stream: BybitLiquidationStream | null = null;
  private bootstrap: BybitLiquidationBootstrap | null = null;
  private live: BybitLiquidationLiveState | null = null;
  private rebuildTimer: number | null = null;
  private refreshTimer: number | null = null;
  private readonly abort = new AbortController();
  private disposed = false;
  private readonly buildGate = new BclifSingleFlightBuildGate();
  private readonly liveStartedAt = Date.now();
  private absoluteGrid: BclifAbsolutePriceGrid | null = null;
  private hasRestoredCheckpoint = false;
  private hasPublishedSnapshot = false;
  private readonly checkpoint: BclifBrowserCheckpointStore | null;

  constructor(options: BrowserLiquidationFieldFallbackOptions) {
    this.options = options;
    this.settings = migrateLiquidationFieldSettings(options.settings);
    this.checkpoint = options.checkpointStore === undefined ? createBrowserCheckpointStore() : options.checkpointStore;
  }

  async start(reason?: string) {
    this.status("LOADING", "Restoring the bounded local public BCLIF checkpoint.", "RESTORING_LOCAL_PUBLIC_CACHE");
    try {
      const restored = await this.checkpoint?.restore(this.options.symbol, this.settings);
      if (restored && !this.disposed) {
        this.hasRestoredCheckpoint = true;
        this.hasPublishedSnapshot = true;
        this.options.onSnapshot(restored);
        this.status("LOADING", "Local browser checkpoint restored; reconciling fresh public OI.", "OI_CONTEXT_READY");
      }
    } catch {
      // Corrupt/inaccessible public cache is disposable; source rebuild remains authoritative.
    }

    this.status("LOADING", reason
      ? `Persistent market memory is unavailable (${reason}); building the browser-session model.`
      : "Building the browser-session liquidation model.", "BACKFILLING_OI");
    const symbol = this.options.symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    this.stream = new BybitLiquidationStream(symbol, (state) => {
      this.live = state;
      this.scheduleBuild();
      const modelReady = this.hasPublishedSnapshot;
      this.status(
        state.connected ? modelReady ? "COLLECTING" : "LOADING" : "STALE",
        state.connected
          ? modelReady
            ? "Live trades, liquidations and L2 depth connected; history accumulates only in this browser session."
            : "Live source connected; backfilling canonical OI and preparing the first thermal raster."
          : "Bybit public stream reconnecting; the last browser-session field remains visible.",
        state.connected
          ? modelReady ? "LIVE_CALIBRATING" : this.bootstrap ? "RENDERER_INITIALIZING" : "BACKFILLING_OI"
          : "SOURCE_UNAVAILABLE"
      );
    });
    this.stream.start();
    try {
      await this.refreshBootstrap();
      if (!this.bootstrap?.frames.length || this.bootstrap.coverage.openInterestCoveragePercent <= 0) {
        this.status("UNAVAILABLE", "Open-interest history is unavailable for this venue/symbol window.", "SOURCE_UNAVAILABLE");
        if (!this.hasRestoredCheckpoint) this.options.onSnapshot(null);
        return;
      }
      this.status("LOADING", "Open-interest history ready; constructing the first thermal raster.", "RENDERER_INITIALIZING");
      await this.build();
      this.refreshTimer = window.setInterval(() => {
        void this.refreshBootstrap().then(() => this.build()).catch((error) => this.fail(error));
      }, 60_000);
    } catch (error) {
      this.fail(error);
    }
  }

  updateSettings(settings: LiquidationFieldSettings) {
    const previousModelKey = liquidationFieldModelSettingsKey(this.settings);
    const previousRows = this.settings.priceRows;
    this.settings = migrateLiquidationFieldSettings(settings);
    if (previousRows !== this.settings.priceRows) this.absoluteGrid = null;
    if (previousModelKey !== liquidationFieldModelSettingsKey(this.settings)) this.scheduleBuild(60);
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.stream?.stop();
    this.worker.dispose();
  }

  private async refreshBootstrap() {
    this.bootstrap = await bootstrapBybitLiquidationField(
      this.options.getCandles(),
      this.options.symbol,
      this.settings,
      this.abort.signal
    );
    const anchor = this.bootstrap.frames[0];
    if (anchor && (!this.absoluteGrid || this.absoluteGrid.rows !== this.settings.priceRows)) {
      const leverageEnvelope = Math.max(0.08, Math.min(0.52, 1 / Math.max(2, this.settings.leverageMinimum) + 0.025));
      this.absoluteGrid = stableBrowserPriceGrid(
        anchor.markPrice,
        this.bootstrap.rules.tickSize ?? 0,
        this.settings.priceRows,
        leverageEnvelope
      );
    }
  }

  private scheduleBuild(delay = this.settings.liveUpdateCadenceMs) {
    if (this.disposed || !this.bootstrap) return;
    // Throttle rather than debounce. Public trades can arrive continuously;
    // resetting the timer on every message would postpone the next raster
    // forever even though the single-flight gate has capacity to coalesce it.
    if (this.rebuildTimer !== null) return;
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      void this.build().catch((error) => this.fail(error));
    }, delay);
  }

  private build() {
    return this.buildGate.run(() => this.buildOnce());
  }

  private async buildOnce() {
    const bootstrap = this.bootstrap;
    if (!bootstrap || this.disposed) return;
    const frames = this.applyLiveState(bootstrap.frames, this.live);
    const events = this.live?.events ?? [];
    const liveCoverageMs = Math.max(0, Date.now() - this.liveStartedAt);
    const requestedMs = Math.max(1, bootstrap.coverage.requestedEnd - bootstrap.coverage.requestedStart);
    const coverage = {
      ...bootstrap.coverage,
      liquidationEventCoveragePercent: Math.min(100, liveCoverageMs / requestedMs * 100),
      orderbookCoveragePercent: this.live?.bidDepthCurve.certainty === "OBSERVED"
        ? Math.min(100, liveCoverageMs / requestedMs * 100)
        : 0,
      state: this.live?.connected ? "COLLECTING" as const : bootstrap.coverage.state
    };
    const snapshot = await this.worker.build({
      frames,
      events,
      rules: bootstrap.rules,
      settings: this.settings,
      coverage,
      absoluteGrid: this.absoluteGrid ?? undefined
    });
    if (this.disposed) return;
    this.hasPublishedSnapshot = true;
    this.options.onSnapshot(snapshot);
    void this.checkpoint?.save(this.options.symbol, this.settings, snapshot).catch(() => undefined);
    this.status(
      this.live?.connected ? "COLLECTING" : "LIVE",
      `${coverage.openInterestCoveragePercent.toFixed(0)}% OI coverage; confirmed-liquidation history ${coverage.liquidationEventCoveragePercent.toFixed(2)}% (browser session).`,
      "LIVE_CALIBRATING"
    );
  }

  private applyLiveState(source: readonly LiquidationMarketFrame[], live: BybitLiquidationLiveState | null) {
    const frames = source.map((frame) => ({ ...frame, certainty: { ...frame.certainty } }));
    const last = frames.at(-1);
    if (!last || !live) return frames;
    const recentEvents = live.events.filter((event) => event.timestamp > last.timestamp - 24 * 60 * 60 * 1_000);
    last.aggressiveBuyNotional = live.aggressiveBuyNotional;
    last.aggressiveSellNotional = live.aggressiveSellNotional;
    last.cvd = live.cvd;
    last.cvdEfficiency = (live.aggressiveBuyNotional + live.aggressiveSellNotional) > 0
      ? Math.abs(live.cvd) / (live.aggressiveBuyNotional + live.aggressiveSellNotional)
      : 0;
    last.bidDepthCurve = live.bidDepthCurve;
    last.askDepthCurve = live.askDepthCurve;
    last.confirmedLongLiquidations = recentEvents
      .filter((event) => event.liquidatedPositionSide === "LONG")
      .reduce((sum, event) => sum + event.notional, 0);
    last.confirmedShortLiquidations = recentEvents
      .filter((event) => event.liquidatedPositionSide === "SHORT")
      .reduce((sum, event) => sum + event.notional, 0);
    last.certainty.trades = live.lastInputAt ? "OBSERVED" : "UNAVAILABLE";
    last.certainty.confirmedLiquidations = live.events.length ? "OBSERVED" : "UNAVAILABLE";
    last.certainty.orderbook = live.bidDepthCurve.certainty;
    return frames;
  }

  private status(
    state: LiquidationFieldRuntimeStatus["state"],
    message: string,
    lifecycle: LiquidationFieldRuntimeStatus["lifecycle"]
  ) {
    if (this.disposed) return;
    this.options.onStatus({
      state,
      message,
      source: "BYBIT_PUBLIC",
      authority: "BROWSER_FALLBACK",
      persistence: "OFF",
      collectorNodeId: null,
      lastInputAt: this.live?.lastInputAt ?? null,
      lifecycle,
    });
  }

  private fail(error: unknown) {
    if (this.disposed || (error instanceof DOMException && error.name === "AbortError")) return;
    const detail = error instanceof Error ? error.message : String(error);
    this.options.onStatus({
      state: "ERROR",
      message: "Browser-session Liquidation Intelligence unavailable",
      source: "BYBIT_PUBLIC",
      authority: "BROWSER_FALLBACK",
      persistence: "OFF",
      collectorNodeId: null,
      lastInputAt: this.live?.lastInputAt ?? null,
      error: detail,
      lifecycle: "FATAL",
    });
  }
}
