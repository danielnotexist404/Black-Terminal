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

export interface BrowserLiquidationFieldFallbackOptions {
  symbol: string;
  settings: LiquidationFieldSettings;
  getCandles: () => Candle[];
  onSnapshot: (snapshot: LiquidationFieldSnapshot | null) => void;
  onStatus: (status: LiquidationFieldRuntimeStatus) => void;
}

/**
 * Explicitly session-scoped browser model. The controller starts this class
 * only after the persistent authority has returned a fallback-safe result.
 * It never consumes or merges a persistent tile.
 */
export class BrowserLiquidationFieldFallback {
  private settings: LiquidationFieldSettings;
  private readonly worker = new LiquidationFieldWorkerClient();
  private stream: BybitLiquidationStream | null = null;
  private bootstrap: BybitLiquidationBootstrap | null = null;
  private live: BybitLiquidationLiveState | null = null;
  private rebuildTimer: number | null = null;
  private refreshTimer: number | null = null;
  private readonly abort = new AbortController();
  private disposed = false;
  private buildGeneration = 0;
  private readonly liveStartedAt = Date.now();
  private absoluteGrid: BclifAbsolutePriceGrid | null = null;

  constructor(private readonly options: BrowserLiquidationFieldFallbackOptions) {
    this.settings = migrateLiquidationFieldSettings(options.settings);
  }

  async start(reason?: string) {
    this.status("LOADING", reason
      ? `Persistent market memory is unavailable (${reason}); building the browser-session model.`
      : "Building the browser-session liquidation model.");
    const symbol = this.options.symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    this.stream = new BybitLiquidationStream(symbol, (state) => {
      this.live = state;
      this.scheduleBuild();
      this.status(
        state.connected ? "COLLECTING" : "STALE",
        state.connected
          ? "Live trades, liquidations and L2 depth connected; history accumulates only in this browser session."
          : "Bybit public stream reconnecting; the last browser-session field remains visible."
      );
    });
    this.stream.start();
    try {
      await this.refreshBootstrap();
      if (!this.bootstrap?.frames.length || this.bootstrap.coverage.openInterestCoveragePercent <= 0) {
        this.status("UNAVAILABLE", "Open-interest history is unavailable for this venue/symbol window.");
        this.options.onSnapshot(null);
        return;
      }
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
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      void this.build().catch((error) => this.fail(error));
    }, delay);
  }

  private async build() {
    if (!this.bootstrap || this.disposed) return;
    const generation = ++this.buildGeneration;
    const frames = this.applyLiveState(this.bootstrap.frames, this.live);
    const events = this.live?.events ?? [];
    const liveCoverageMs = Math.max(0, Date.now() - this.liveStartedAt);
    const requestedMs = Math.max(1, this.bootstrap.coverage.requestedEnd - this.bootstrap.coverage.requestedStart);
    const coverage = {
      ...this.bootstrap.coverage,
      liquidationEventCoveragePercent: Math.min(100, liveCoverageMs / requestedMs * 100),
      orderbookCoveragePercent: this.live?.bidDepthCurve.certainty === "OBSERVED"
        ? Math.min(100, liveCoverageMs / requestedMs * 100)
        : 0,
      state: this.live?.connected ? "COLLECTING" as const : this.bootstrap.coverage.state
    };
    const snapshot = await this.worker.build({
      frames,
      events,
      rules: this.bootstrap.rules,
      settings: this.settings,
      coverage,
      absoluteGrid: this.absoluteGrid ?? undefined
    });
    if (this.disposed || generation !== this.buildGeneration) return;
    this.options.onSnapshot(snapshot);
    this.status(
      this.live?.connected ? "COLLECTING" : "LIVE",
      `${coverage.openInterestCoveragePercent.toFixed(0)}% OI coverage; confirmed-liquidation history ${coverage.liquidationEventCoveragePercent.toFixed(2)}% (browser session).`
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

  private status(state: LiquidationFieldRuntimeStatus["state"], message: string) {
    if (this.disposed) return;
    this.options.onStatus({
      state,
      message,
      source: "BYBIT_PUBLIC",
      authority: "BROWSER_FALLBACK",
      persistence: "OFF",
      collectorNodeId: null,
      lastInputAt: this.live?.lastInputAt ?? null
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
      error: detail
    });
  }
}
