import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Text
} from "pixi.js";
import { CandleBuffer } from "./data/CandleBuffer";
import { VolumeProfileModel, VolumeProfileResult, VolumeProfileRow } from "./profile/VolumeProfileModel";
import {
  defaultIndicatorAdvancedSettings,
  defaultOscillatorPaneSettings,
  defaultVwapSettings,
  defaultWaveTrendOscillatorSettings
} from "./profile/volumeProfileDefaults";
import {
  calculateInstitutionalVwap,
  type InstitutionalVwapPoint,
  type InstitutionalVwapResult
} from "./indicators/institutionalVwap";
import { resolveOscillatorStack } from "./indicators/oscillatorLayout";
import type { IndicatorAlertDefinition } from "../automation/alerts";
import type { CompiledPlot } from "../components/ScriptCompiler";
import { createAdaptiveSwingSignals } from "../modules/strategy-lab/adapters/signalAdapter";
import type { StrategySettings, StrategySignal } from "../modules/strategy-lab/types/strategy.types";
import { blackCorePerformanceMonitor } from "../performance/performanceMonitor";
import { blackCoreResourceTracker } from "../performance/resourceTracker";
import type { KioseffSnapshot } from "../modules/kioseff-stop-loss-clustering/core/canonical";
import {
  KIOSEFF_DEFAULT_SETTINGS,
  migrateKioseffSettings,
  type KioseffSettingsV1
} from "../modules/kioseff-stop-loss-clustering/core/settings";
import { KioseffPixiRenderer } from "../modules/kioseff-stop-loss-clustering/rendering/KioseffPixiRenderer";
import { kioseffPriceDomain } from "../modules/kioseff-stop-loss-clustering/rendering/renderModel";
import { AuctionProfileRenderer } from "../modules/auction-profile/rendering/AuctionProfileRenderer";
import { CvdFootprintRenderer } from "../modules/auction-profile/rendering/footprint/CvdFootprintRenderer";
import { resolveAuctionVisualizationLayers } from "../modules/auction-profile/rendering/visualization";
import { AUCTION_PROFILE_DEFAULT_SETTINGS, migrateAuctionProfileSettings } from "../modules/auction-profile/core/settings";
import type { AuctionProfileSettings, AuctionProfileSnapshot } from "../modules/auction-profile/core/types";
import { resolveChartDeviceCapabilities } from "./deviceCapabilities";
import type { LiquidationFieldSettings, LiquidationFieldSnapshot } from "../modules/liquidation-field/core/types";
import { migrateLiquidationFieldSettings } from "../modules/liquidation-field/core/settings";
import { BlackCoreLiquidationFieldRenderer, type BclifRendererMetrics } from "../modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer";
import { resolveBclifDisplayDomain } from "../modules/liquidation-field/rendering/displayProjection";
import { bclifTimestampMsToChartSeconds } from "../modules/liquidation-field/rendering/timeProjection";
import type { DDAProSnapshot } from "../modules/dda-pro/core/types";
import {
  ddaProDomain,
  ddaProValueToY,
  panDDAProCamera,
  resetDDAProCamera,
  zoomDDAProCamera,
  type DDAProCamera
} from "../modules/dda-pro/rendering/camera";

import {
  fromAxisValue,
  priceToScreenY as mapPriceToScreenY,
  screenYToPrice as mapScreenYToPrice,
  toAxisValue,
  type ChartPriceScaleMode,
  type ChartPriceTransformSnapshot
} from "./priceTransform";
import {
  AdaptiveSwingStrategySettings,
  Candle,
  ChartDisplayType,
  ChartEngineOptions,
  ChartTheme,
  DrawingToolId,
  FeedEvent,
  IndicatorAdvancedSettings,
  IndicatorColorKey,
  IndicatorPeriods,
  IndicatorVisualSettings,
  ReplaySelection,
  ViewState,
  VisibleIndicators,
  VolumeProfileSettings
} from "./types";

const theme: ChartTheme = {
  background: 0x000000,
  grid: 0xff344a,
  gridAlpha: 0.052,
  text: 0xf7f2f4,
  muted: 0x8f878d,
  red: 0xe3132d,
  redBright: 0xff3d52,
  orange: 0xff6a00,
  orangeBright: 0xffb000,
  silver: 0xa9a3a8,
  silverBright: 0xeee9ec,
  green: 0x4bd58a
};

const MIN_CANDLE_WIDTH = 0.18;
const MAX_CANDLE_WIDTH = 26;
const MIN_CANDLE_GAP = 0.04;
const MAX_CANDLE_GAP = 8;

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

type DrawingPoint = {
  index: number;
  price: number;
};

type DrawingShape = {
  id: number;
  tool: DrawingToolId;
  points: DrawingPoint[];
  text?: string;
};

type AdaptiveSwingTradeEvent = {
  kind: "entry" | "takeProfit" | "stopLoss";
  direction: "long" | "short";
  index: number;
  price: number;
};

export type ChartPoint = {
  index: number;
  price: number;
  time?: number;
  clientX: number;
  clientY: number;
  localX: number;
  localY: number;
};

export type IndicatorAlertLevel = {
  kind: "poc" | "vah" | "val" | "lvn";
  label: string;
  price: number;
  priceLow?: number;
  priceHigh?: number;
  strength?: number;
};

export type IndicatorAlertLine = {
  current?: number;
  previous?: number;
  period?: number;
};

export type IndicatorAlertSnapshot = {
  current?: Candle;
  previous?: Candle;
  volumeProfileLevels: IndicatorAlertLevel[];
  vwap?: IndicatorAlertLine;
  ema20?: IndicatorAlertLine;
  ema50?: IndicatorAlertLine;
  ema200?: IndicatorAlertLine;
};

export class BlackChartEngine {
  private host: HTMLDivElement;
  private app = new Application();
  private destroyed = false;
  private candles: CandleBuffer;
  private displayedCandles: Candle[] = [];
  private liquidationFieldRenderer = new BlackCoreLiquidationFieldRenderer((metrics) => {
    this.queueDraw();
    this.onLiquidationRendererMetrics?.(metrics);
  });
  private liquidationFieldSnapshot: LiquidationFieldSnapshot | null = null;
  private liquidationFieldSettings: LiquidationFieldSettings = migrateLiquidationFieldSettings();
  private kioseffRenderer = new KioseffPixiRenderer();
  private kioseffSnapshot: KioseffSnapshot | null = null;
  private kioseffSettings: KioseffSettingsV1 = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
  private auctionProfileRenderer = new AuctionProfileRenderer();
  private cvdFootprintRenderer = new CvdFootprintRenderer();
  private auctionProfileSnapshots: AuctionProfileSnapshot[] = [];
  private ddaProSnapshot: DDAProSnapshot | null = null;
  private auctionProfileSettings: AuctionProfileSettings = structuredClone(AUCTION_PROFILE_DEFAULT_SETTINGS);
  private constrainedTouchRenderer = false;
  private volumeProfileModel = new VolumeProfileModel();
  private lastVolumeProfileResult?: VolumeProfileResult;
  private lastVolumeProfileHdlxByIndex = new Map<number, number>();
  private volumeProfileCache?: { key: string; result: VolumeProfileResult | null };
  private adaptiveSwingCache?: { key: string; signals: StrategySignal[] };
  private volumeProfileDataVersion = 0;
  private fixedVolumeProfileRange?: {
    key: string;
    startTime: number;
    endTime: number;
  };
  private heatmapVisibleUntilIndex?: number;
  private chartType: ChartDisplayType = "candlesticks";
  private snapToLatest = true;
  private onPriceChange?: (price: number) => void;
  private onCandleChange?: (candle: Candle) => void;
  private onPriceTransformChange?: (transform: ChartPriceTransformSnapshot) => void;
  private onLiquidationRendererMetrics?: (metrics: BclifRendererMetrics) => void;
  private onNeedMoreHistory?: (oldestCandle: Candle) => void;
  private onFps?: (fps: number) => void;
  private onAlertEditRequest?: (alertId: string) => void;
  private activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDistance: number | null = null;
  private lastCountdownTime = 0;
  private customPlots: CompiledPlot[] = [];
  private alertDefinitions: IndicatorAlertDefinition[] = [];
  private visibleIndicators: VisibleIndicators = {
    liquidationHeatmap: false,
    auctionProfile: false,
    volatilityHeatmap: false,
      volumeProfile: false,
      aif: false,
    adaptiveSwingStrategy: false,
    vwap: true,
    ema20: true,
    ema50: true,
    ema200: true,
    sma20: false,
    sma50: false,
    bollinger: false,
    openInterestOscillator: false,
    zScoreOscillator: false,
    waveTrendOscillator: false,
    ddaProOscillator: false,
    volume: true
  };
  private indicatorPeriods: IndicatorPeriods = {
    volatilityHeatmap: 34,
    volumeProfile: 5000,
    ema20: 20,
    ema50: 50,
    ema200: 200,
    sma20: 20,
    sma50: 50,
    bollinger: 20,
    openInterestOscillator: 34,
    zScoreOscillator: 50,
    waveTrendOscillator: 10,
    ddaProOscillator: 500
  };
  private indicatorVisualSettings: IndicatorVisualSettings = {
    liquidationHeatmap: { color: "red", intensity: 78 },
    auctionProfile: { color: "red", intensity: 82 },
    volatilityHeatmap: { color: "green", intensity: 86 },
      volumeProfile: { color: "red", intensity: 72 },
      aif: { color: "red", intensity: 78 },
    adaptiveSwingStrategy: { color: "green", intensity: 86 },
    vwap: { color: "gray", intensity: 58 },
    ema20: { color: "white", intensity: 62 },
    ema50: { color: "silver", intensity: 48 },
    ema200: { color: "red", intensity: 76 },
    sma20: { color: "silver", intensity: 56 },
    sma50: { color: "gray", intensity: 46 },
    bollinger: { color: "silver", intensity: 54 },
    openInterestOscillator: { color: "red", intensity: 82 },
    zScoreOscillator: { color: "white", intensity: 74 },
    waveTrendOscillator: { color: "silver", intensity: 78 },
    ddaProOscillator: { color: "red", intensity: 92 },
    volume: { color: "red", intensity: 62 }
  };
  private indicatorAdvancedSettings: IndicatorAdvancedSettings = defaultIndicatorAdvancedSettings;
  private institutionalVwapCache?: { key: string; result: InstitutionalVwapResult };

  private rootLayer = new Container();
  private gridLayer = new Graphics();
  private watermarkLayer = new Graphics();
  private heatmapLayer = new Graphics();
  private candleLayer = new Graphics();
  private volumeLayer = new Graphics();
  private indicatorLayer = new Graphics();
  private drawingLayer = new Container();
  private drawingGraphics = new Graphics();
  private alertLayer = new Graphics();
  private alertTextLayer = new Container();
  private axisLayer = new Graphics();
  private crosshairLayer = new Graphics();
  private priceTexts: Text[] = [];
  private timeTexts: Text[] = [];
  private labelTexts: Text[] = [];
  private hudTexts: Text[] = [];
  private axisTextPool: Text[] = [];
  private crosshairTexts: Text[] = [];
  private drawingTexts: Text[] = [];
  private profileTexts: Text[] = [];
  private heatmapTexts: Text[] = [];
  private alertTexts: Text[] = [];
  private priceLineColor = "";
  private priceLineIntensity = 75;

  private view: ViewState = {
    width: 800,
    height: 500,
    rightAxisWidth: 88,
    bottomAxisHeight: 58,
    topPadding: 38,
    bottomPadding: 84,
    candleWidth: 4.8,
    gap: 2.2,
    scrollX: 0,
    priceMin: 64000,
    priceMax: 68000,
    firstIndex: 0,
    lastIndex: 0
  };

  private pointer = { x: -1, y: -1, active: false };
  private dragging = false;
  private ddaProDragging = false;
  private ddaProCamera = resetDDAProCamera();
  private ddaProDragStartCamera: DDAProCamera = resetDDAProCamera();
  private ddaProDragStartBaseDepth = 1;
  private priceScaleDragging = false;
  private priceScaleHover = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartScroll = 0;
  private dragStartPriceMin = 0;
  private dragStartPriceMax = 0;
  private priceScaleDragStartY = 0;
  private priceScaleDragStartMin = 0;
  private priceScaleDragStartMax = 0;
  private manualPriceRange?: { min: number; max: number };
  private priceScaleMode: ChartPriceScaleMode = "linear";
  private priceTransformRevision = 0;
  private lastPriceTransformKey = "";
  private activeDrawingTool: DrawingToolId = "cursor";
  private drawingsVisible = true;
  private drawingsLocked = false;
  private drawings: DrawingShape[] = [];
  private draftDrawing?: DrawingShape;
  private nextDrawingId = 1;
  private activeBrushId?: number;
  private replaySelectionMode?: (selection: ReplaySelection) => void;
  private resizeObserver?: ResizeObserver;
  private resizeRaf?: number;
  private drawRaf?: number;
  private mockTimer?: number;
  private frameCount = 0;
  private lastFpsTime = performance.now();
  private lastTickerFrameAt = performance.now();
  private readonly resourceOwner = `pixi-chart:${Math.random().toString(36).slice(2)}`;
  private releaseVisibilityListener?: () => void;
  private releaseResizeObserver?: () => void;

  constructor(options: ChartEngineOptions) {
    this.host = options.host;
    this.candles = new CandleBuffer(options.candles);
    if (options.chartType) this.chartType = options.chartType;
    if (options.snapToLatest !== undefined) this.snapToLatest = options.snapToLatest;
    if (options.visibleIndicators) this.visibleIndicators = options.visibleIndicators;
    if (options.indicatorPeriods) this.indicatorPeriods = options.indicatorPeriods;
    if (options.indicatorVisualSettings) this.indicatorVisualSettings = options.indicatorVisualSettings;
    if (options.indicatorAdvancedSettings) this.indicatorAdvancedSettings = options.indicatorAdvancedSettings;
    this.liquidationFieldSettings = migrateLiquidationFieldSettings(this.indicatorAdvancedSettings.liquidationField);
    if (options.kioseffSnapshot !== undefined) this.kioseffSnapshot = options.kioseffSnapshot;
    if (options.kioseffSettings) {
      this.kioseffSettings = migrateKioseffSettings(options.kioseffSettings);
    }
    this.setHeatmapSource(options.candles);
    if (options.auctionProfileSnapshots !== undefined) this.auctionProfileSnapshots = options.auctionProfileSnapshots;
    else if (options.auctionProfileSnapshot !== undefined) this.auctionProfileSnapshots = options.auctionProfileSnapshot ? [options.auctionProfileSnapshot] : [];
    if (options.ddaProSnapshot !== undefined) this.ddaProSnapshot = options.ddaProSnapshot;
    if (options.auctionProfileSettings) {
      this.auctionProfileSettings = migrateAuctionProfileSettings(options.auctionProfileSettings);
    }
    this.onPriceChange = options.onPriceChange;
    this.onCandleChange = options.onCandleChange;
    this.onPriceTransformChange = options.onPriceTransformChange;
    this.onLiquidationRendererMetrics = options.onLiquidationRendererMetrics;
    this.onNeedMoreHistory = options.onNeedMoreHistory;
    this.onFps = options.onFps;
    this.alertDefinitions = options.alertDefinitions ?? [];
    this.onAlertEditRequest = options.onAlertEditRequest;
    if (options.priceLineColor !== undefined) this.priceLineColor = options.priceLineColor;
    if (options.priceLineIntensity !== undefined) this.priceLineIntensity = options.priceLineIntensity;
  }

  async init() {
    const device = resolveChartDeviceCapabilities({
      devicePixelRatio: window.devicePixelRatio || 1,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      platform: navigator.platform || "",
      userAgent: navigator.userAgent || ""
    });
    this.constrainedTouchRenderer = device.constrainedTouchRenderer;
    await this.app.init({
      background: theme.background,
      antialias: true,
      autoDensity: true,
      resolution: device.rendererResolution,
      resizeTo: this.host,
      preference: "webgl",
      powerPreference: "high-performance"
    });

    this.app.canvas.addEventListener("webglcontextlost", this.onBclifContextLost);
    this.app.canvas.addEventListener("webglcontextrestored", this.onBclifContextRestored);
    this.host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.rootLayer);

    this.rootLayer.addChild(
      this.gridLayer,
      this.watermarkLayer,
      this.liquidationFieldRenderer.container,
      this.heatmapLayer,
      this.kioseffRenderer.container,
      this.volumeLayer,
      this.candleLayer,
      this.cvdFootprintRenderer.container,
      this.auctionProfileRenderer.container,
      this.indicatorLayer,
      this.drawingLayer,
      this.alertLayer,
      this.axisLayer,
      this.alertTextLayer,
      this.crosshairLayer
    );
    this.drawingLayer.addChild(this.drawingGraphics);
    blackCoreResourceTracker.setGauge("pixi-container", this.resourceOwner, 6);
    blackCoreResourceTracker.setGauge("pixi-graphics", this.resourceOwner, 17);
    blackCoreResourceTracker.setGauge("pixi-text", this.resourceOwner, 0);

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;

    this.app.stage.on("pointermove", (e: FederatedPointerEvent) => {
      this.pointer = { x: e.global.x, y: e.global.y, active: true };
      const ddaPaneBounds = this.ddaProPaneBounds();
      const insideDdaAxis = Boolean(
        ddaPaneBounds
        && e.global.y >= ddaPaneBounds.top
        && e.global.y <= ddaPaneBounds.bottom
        && e.global.x >= ddaPaneBounds.plotWidth - 24
      );
      this.setPriceScaleHover(!insideDdaAxis && this.isInsidePriceAxis(e.global.x, e.global.y));
      this.host.classList.toggle("dda-pro-scale-hover", insideDdaAxis);
      this.activePointers.set(e.pointerId, { x: e.global.x, y: e.global.y });

      if (this.activePointers.size === 2) {
        this.ddaProDragging = false;
        const coords = Array.from(this.activePointers.values());
        const dx = coords[0].x - coords[1].x;
        const dy = coords[0].y - coords[1].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (this.lastPinchDistance !== null && this.lastPinchDistance > 0) {
          const factor = dist / this.lastPinchDistance;
          const centerX = (coords[0].x + coords[1].x) / 2;
          this.zoomTimeAxis(factor, centerX);
          this.queueDraw();
        }
        this.lastPinchDistance = dist;
        return;
      }

      if (this.ddaProDragging) {
        const dx = e.global.x - this.dragStartX;
        const dy = e.global.y - this.dragStartY;
        this.view.scrollX = this.clampHorizontalScroll(this.dragStartScroll + dx);
        const pane = this.ddaProPaneBounds();
        if (pane) {
          this.ddaProCamera = panDDAProCamera(
            this.ddaProDragStartCamera,
            this.ddaProDragStartBaseDepth,
            dy,
            pane.height
          );
        }
        this.queueDraw();
      } else if (this.handleDrawingPointerMove(e)) {
        return;
      } else if (this.priceScaleDragging) {
        this.scalePriceAxis(e.global.y);
      } else if (this.dragging) {
        const dx = e.global.x - this.dragStartX;
        const dy = e.global.y - this.dragStartY;
        this.view.scrollX = this.clampHorizontalScroll(this.dragStartScroll + dx);
        this.panPriceAxis(dy);
        this.queueDraw();
      } else {
        this.drawCrosshair();
        const visualization = this.auctionProfileSettings.rendering.visualizationType;
        if (this.visibleIndicators.auctionProfile && visualization !== "CVD_FOOTPRINT") this.auctionProfileRenderer.drawHover(e.global.x, e.global.y);
        if (this.chartType === "volumeFootprint" || (this.visibleIndicators.auctionProfile && visualization !== "AUCTION_PROFILE")) this.cvdFootprintRenderer.drawHover(e.global.x, e.global.y);
      }
    });

    this.app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
      this.activePointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
      if (this.activePointers.size === 2) {
        this.ddaProDragging = false;
        this.dragging = false;
        const coords = Array.from(this.activePointers.values());
        const dx = coords[0].x - coords[1].x;
        const dy = coords[0].y - coords[1].y;
        this.lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
        return;
      }

      if (e.button !== 0) return;

      if (this.handleReplaySelectionPointerDown(e)) return;

      const ddaPaneBounds = this.ddaProPaneBounds();
      if (
        ddaPaneBounds
        && e.global.x >= 0
        && e.global.x <= this.view.width
        && e.global.y >= ddaPaneBounds.top
        && e.global.y <= ddaPaneBounds.bottom
      ) {
        this.ddaProDragging = true;
        this.dragStartX = e.global.x;
        this.dragStartY = e.global.y;
        this.dragStartScroll = this.view.scrollX;
        this.ddaProDragStartCamera = { ...this.ddaProCamera };
        this.ddaProDragStartBaseDepth = this.ddaProBaseDepth();
        this.host.classList.add("dda-pro-dragging");
        return;
      }

      if (this.isInsidePriceAxis(e.global.x, e.global.y)) {
        this.priceScaleDragging = true;
        this.priceScaleDragStartY = e.global.y;
        this.priceScaleDragStartMin = this.view.priceMin;
        this.priceScaleDragStartMax = this.view.priceMax;
        this.host.classList.add("price-scale-dragging");
        return;
      }

      if (this.handleDrawingPointerDown(e)) return;

      this.dragging = true;
      this.dragStartX = e.global.x;
      this.dragStartY = e.global.y;
      this.dragStartScroll = this.view.scrollX;
      this.dragStartPriceMin = this.view.priceMin;
      this.dragStartPriceMax = this.view.priceMax;
    });

    const cleanUpPointer = (e: FederatedPointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) {
        this.lastPinchDistance = null;
      }
      this.finishBrushDrawing();
      this.stopDragging();
    };

    this.app.stage.on("pointerup", cleanUpPointer);
    this.app.stage.on("pointerupoutside", cleanUpPointer);
    this.app.stage.on("pointercancel", cleanUpPointer);
    this.app.stage.on("pointerleave", () => {
      this.pointer.active = false;
      this.auctionProfileRenderer.clearHover();
      this.cvdFootprintRenderer.clearHover();
      this.setPriceScaleHover(false);
      this.finishBrushDrawing();
      this.stopDragging();
      this.drawCrosshair();
    });

    this.host.addEventListener("wheel", this.onWheel, { passive: false });
    this.host.addEventListener("dblclick", this.onDoubleClick);
    this.host.addEventListener("contextmenu", this.onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this.queueResize());
    this.releaseResizeObserver = blackCoreResourceTracker.acquire("observer", `${this.resourceOwner}:resize`);
    this.resizeObserver.observe(this.host);
    window.addEventListener("black-terminal-layout-resize", this.queueResize);
    window.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.releaseVisibilityListener = blackCoreResourceTracker.acquire("listener", `${this.resourceOwner}:visibility`);

    this.app.ticker.add(() => this.tickFps());
    this.resize();
    this.draw();
  }

  startMockFeed(timeframeSeconds = 60 * 15, onEvent?: (event: FeedEvent) => void) {
    if (this.mockTimer) window.clearInterval(this.mockTimer);
    const timeframeScale = Math.max(0.42, Math.min(3.2, Math.sqrt(timeframeSeconds / (60 * 15))));
    this.mockTimer = window.setInterval(() => {
      const last = this.candles.last();
      if (!last) return;

      const drift = (Math.random() - 0.52) * last.close * 0.00027 * timeframeScale;
      const close = Math.max(last.close * 0.1, last.close + drift);
      const wick = last.close * (0.00012 * timeframeScale + Math.random() * 0.00034 * timeframeScale);
      const currentBucket = Math.floor(Date.now() / 1000 / timeframeSeconds) * timeframeSeconds;
      const shouldRollCandle = currentBucket > last.time;
      const next: Candle = {
        time: shouldRollCandle ? currentBucket : last.time,
        open: last.close,
        high: Math.max(last.close, close) + wick,
        low: Math.min(last.close, close) - wick * (0.75 + Math.random() * 0.5),
        close,
        volume: 420 + Math.abs(close - last.close) * 18 + Math.random() * 620 * timeframeScale
      };

      let emittedCandle = next;
      if (shouldRollCandle) {
        this.candles.push(next);
      } else {
        emittedCandle = {
          ...last,
          high: Math.max(last.high, close),
          low: Math.min(last.low, close),
          close,
          volume: last.volume + Math.max(1, Math.abs(close - last.close) * 4)
        };
        this.candles.updateLast(emittedCandle);
      }

      this.volumeProfileDataVersion += 1;
      this.setHeatmapSource(this.candles.all());
      this.onPriceChange?.(close);
      this.onCandleChange?.(emittedCandle);
      this.draw();

      if (Math.random() > 0.86) {
        onEvent?.({
          type: "alert",
          signal: close > 66650 ? "price_above_liquidity" : "mean_reversion_watch",
          price: close
        });
      }
    }, 900);
  }

  setCandles(
    candles: Candle[],
    options: { preserveView?: boolean; heatmapSource?: Candle[]; heatmapUntilIndex?: number } = {}
  ) {
    this.candles = new CandleBuffer(candles);
    this.volumeProfileDataVersion += 1;
    this.setHeatmapSource(options.heatmapSource ?? candles, options.heatmapUntilIndex);
    if (!options.preserveView) {
      this.view.scrollX = 0;
      this.manualPriceRange = undefined;
    }
    const last = this.candles.last();
    this.onPriceChange?.(last?.close ?? 0);
    if (last) this.onCandleChange?.(last);
    this.draw();
  }

  prependCandles(candles: Candle[]) {
    const added = this.candles.prepend(candles);
    if (added > 0) {
      this.volumeProfileDataVersion += 1;
      this.setHeatmapSource(this.candles.all());
      this.draw();
    }
  }

  upsertCandle(candle: Candle) {
    const last = this.candles.last();
    if (last && candle.time < last.time) return;
    if (last?.time === candle.time) {
      this.candles.updateLast(candle);
    } else {
      this.candles.push(candle);
    }

    this.volumeProfileDataVersion += 1;
    this.setHeatmapSource(this.candles.all());
    this.onPriceChange?.(candle.close);
    this.onCandleChange?.(candle);
    this.draw();
  }

  updateLastPrice(price: number) {
    this.onPriceChange?.(price);
  }

  getChartPointFromClient(clientX: number, clientY: number): ChartPoint | null {
    const bounds = this.host.getBoundingClientRect();
    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;
    if (!this.isInsidePlot(localX, localY)) return null;

    const index = this.indexForX(localX);
    const candle = this.getDisplayCandles()[index];
    return {
      index,
      price: this.priceForY(localY),
      time: candle?.time,
      clientX,
      clientY,
      localX,
      localY
    };
  }

  priceToScreenY(price: number) {
    return mapPriceToScreenY(price, this.getPriceTransformSnapshot());
  }

  getScreenYForPrice(price: number) {
    return this.priceToScreenY(price);
  }

  screenYToPrice(localY: number) {
    return mapScreenYToPrice(localY, this.getPriceTransformSnapshot());
  }

  getPriceTransformSnapshot(): ChartPriceTransformSnapshot {
    const plotBottom = this.view.topPadding + this.getPricePlotHeight();
    return {
      revision: this.priceTransformRevision,
      width: this.view.width,
      height: this.view.height,
      plotLeft: 0,
      plotRight: this.view.width - this.view.rightAxisWidth,
      plotTop: this.view.topPadding,
      plotBottom,
      priceMin: this.view.priceMin,
      priceMax: this.view.priceMax,
      scaleMode: this.priceScaleMode,
      firstIndex: this.view.firstIndex,
      lastIndex: this.view.lastIndex
    };
  }

  setPriceScaleMode(mode: ChartPriceScaleMode) {
    if (this.priceScaleMode === mode) return;
    this.priceScaleMode = mode;
    this.manualPriceRange = undefined;
    this.queueDraw();
  }

  getPriceFromClientY(clientY: number) {
    const bounds = this.host.getBoundingClientRect();
    return this.priceForY(clientY - bounds.top);
  }

  addDrawingAtPoint(tool: DrawingToolId, index: number, price: number, text?: string) {
    if (tool !== "horizontalLine" && tool !== "verticalLine" && tool !== "text") return false;

    this.drawings.push({
      id: this.nextDrawingId++,
      tool,
      points: [{ index, price }],
      text: tool === "text" ? text ?? "Text" : undefined
    });
    this.draw();
    return true;
  }

  getIndicatorAlertSnapshot(options: { includeVolumeProfile?: boolean } = {}): IndicatorAlertSnapshot {
    const data = this.getDisplayCandles();
    const current = data[data.length - 1];
    const previous = data[data.length - 2];
    const closes = data.map((candle) => candle.close);
    const ema20 = this.emaSeries(closes, this.indicatorPeriods.ema20);
    const ema50 = this.emaSeries(closes, this.indicatorPeriods.ema50);
    const ema200 = this.emaSeries(closes, this.indicatorPeriods.ema200);
    const vwap = this.vwapSeriesForAlerts(data);
    const snapshot: IndicatorAlertSnapshot = {
      current,
      previous,
      volumeProfileLevels: [],
      vwap: { current: vwap[data.length - 1], previous: vwap[data.length - 2] },
      ema20: { current: ema20[data.length - 1], previous: ema20[data.length - 2], period: this.indicatorPeriods.ema20 },
      ema50: { current: ema50[data.length - 1], previous: ema50[data.length - 2], period: this.indicatorPeriods.ema50 },
      ema200: { current: ema200[data.length - 1], previous: ema200[data.length - 2], period: this.indicatorPeriods.ema200 }
    };

    if (options.includeVolumeProfile || this.visibleIndicators.volumeProfile) {
      const result = this.getVolumeProfileResult(data, this.indicatorAdvancedSettings.volumeProfile);
      if (result) {
        const maxVolume = Math.max(...result.rows.map((row) => row.totalVolume), 1);
        snapshot.volumeProfileLevels = [
          { kind: "poc", label: "POC", price: result.pocPrice },
          { kind: "vah", label: "VAH", price: result.valueAreaHigh },
          { kind: "val", label: "VAL", price: result.valueAreaLow },
          ...result.rows
            .filter((row) => row.profileGap)
            .map((row) => ({
              kind: "lvn" as const,
              label: "LVN",
              price: row.price,
              priceLow: row.priceLow,
              priceHigh: row.priceHigh,
              strength: 1 - row.totalVolume / maxVolume
            }))
        ];
      }
    }

    return snapshot;
  }

  setIndicatorState(
    visibleIndicators: VisibleIndicators,
    indicatorPeriods: IndicatorPeriods,
    indicatorVisualSettings = this.indicatorVisualSettings,
    indicatorAdvancedSettings = this.indicatorAdvancedSettings
  ) {
    this.visibleIndicators = visibleIndicators;
    this.indicatorPeriods = indicatorPeriods;
    this.indicatorVisualSettings = indicatorVisualSettings;
    this.indicatorAdvancedSettings = indicatorAdvancedSettings;
    this.liquidationFieldSettings = migrateLiquidationFieldSettings(indicatorAdvancedSettings.liquidationField);
    this.setHeatmapSource(this.candles.all(), this.heatmapVisibleUntilIndex);
    this.draw();
  }

  setDDAProState(snapshot: DDAProSnapshot | null) {
    this.ddaProSnapshot = snapshot;
    this.draw();
  }

  setLiquidationFieldState(snapshot: LiquidationFieldSnapshot | null, settings = this.liquidationFieldSettings) {
    this.liquidationFieldSnapshot = snapshot;
    this.liquidationFieldSettings = migrateLiquidationFieldSettings(settings);
    this.liquidationFieldRenderer.setState(
      this.visibleIndicators.liquidationHeatmap ? snapshot : null,
      this.liquidationFieldSettings
    );
    this.draw();
  }

  getSourceCandles() {
    return this.candles.all().map((candle) => ({ ...candle }));
  }

  setKioseffState(snapshot: KioseffSnapshot | null, settings = this.kioseffSettings) {
    this.kioseffSnapshot = snapshot;
    // Normalize legacy palette values at the renderer boundary as well as when
    // a workspace is reopened. A deployed SPA can otherwise keep an older
    // cyan/pink/purple settings object alive until the next hard reload.
    this.kioseffSettings = migrateKioseffSettings(settings);
    this.draw();
  }

  getKioseffRenderMetrics() {
    return this.kioseffRenderer.metrics();
  }

  setPriceLineSettings(color: string, intensity: number) {

    this.priceLineColor = color;
    this.priceLineIntensity = intensity;
    this.draw();
  }

  setAuctionProfileState(snapshots: AuctionProfileSnapshot | readonly AuctionProfileSnapshot[] | null, settings = this.auctionProfileSettings) {
    this.auctionProfileSnapshots = snapshots ? (Array.isArray(snapshots) ? [...snapshots] : [snapshots as AuctionProfileSnapshot]) : [];
    this.auctionProfileSettings = migrateAuctionProfileSettings(settings);
    this.draw();
  }

  getAuctionProfileRenderMetrics() {
    return this.auctionProfileRenderer.metrics();
  }

  setAlertDefinitions(alertDefinitions: IndicatorAlertDefinition[]) {
    this.alertDefinitions = alertDefinitions;
    this.draw();
  }

  setChartType(chartType: ChartDisplayType) {
    if (this.chartType === chartType) return;
    this.chartType = chartType;
    this.displayedCandles = [];
    this.manualPriceRange = undefined;
    this.draw();
  }

  setSnapToLatest(enabled: boolean) {
    if (this.snapToLatest === enabled) return;
    this.snapToLatest = enabled;
    if (enabled) this.view.scrollX = 0;
    else this.view.scrollX = this.clampHorizontalScroll(this.view.scrollX);
    this.queueDraw();
  }

  setDrawingTool(tool: DrawingToolId) {
    this.activeDrawingTool = tool;
    this.host.classList.toggle("drawing-eraser", tool === "eraser");
    if (tool === "cursor" || tool === "eraser") {
      this.draftDrawing = undefined;
      this.activeBrushId = undefined;
    }
    this.draw();
  }

  setDrawingsVisible(visible: boolean) {
    this.drawingsVisible = visible;
    this.draw();
  }

  setDrawingsLocked(locked: boolean) {
    this.drawingsLocked = locked;
    if (locked) {
      this.draftDrawing = undefined;
      this.activeBrushId = undefined;
    }
    this.draw();
  }

  clearDrawings() {
    this.drawings = [];
    this.draftDrawing = undefined;
    this.activeBrushId = undefined;
    this.draw();
  }

  setReplaySelectionMode(enabled: boolean, onSelect?: (selection: ReplaySelection) => void) {
    this.replaySelectionMode = enabled && onSelect ? onSelect : undefined;
    this.host.classList.toggle("replay-selecting", Boolean(this.replaySelectionMode));
  }

  ingestTrade(price: number, quantity: number, time: number, timeframeSeconds: number) {
    const bucket = Math.floor(time / timeframeSeconds) * timeframeSeconds;
    const last = this.candles.last();
    if (!last) return;

    if (bucket < last.time) {
      this.onPriceChange?.(price);
      return;
    }

    if (bucket === last.time) {
      const next = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
        volume: last.volume + quantity
      };
      this.candles.updateLast(next);
      this.onCandleChange?.(next);
    } else {
      const next = {
        time: bucket,
        open: last.close,
        high: Math.max(last.close, price),
        low: Math.min(last.close, price),
        close: price,
        volume: quantity
      };
      this.candles.push(next);
      this.onCandleChange?.(next);
    }

    this.volumeProfileDataVersion += 1;
    this.setHeatmapSource(this.candles.all());
    this.onPriceChange?.(price);
    this.draw();
  }

  private setHeatmapSource(candles: Candle[], visibleUntilIndex = candles.length - 1) {
    this.heatmapVisibleUntilIndex = Math.max(0, Math.min(Math.max(0, candles.length - 1), visibleUntilIndex));
  }

  private onBclifContextLost = (event: Event) => {
    event.preventDefault();
    this.liquidationFieldRenderer.handleContextLost();
  };

  private onBclifContextRestored = () => {
    this.liquidationFieldRenderer.handleContextRestored();
    this.liquidationFieldRenderer.setState(this.liquidationFieldSnapshot, this.liquidationFieldSettings);
    this.queueDraw();
  };

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.mockTimer) window.clearInterval(this.mockTimer);
    this.host.removeEventListener("wheel", this.onWheel);
    this.host.removeEventListener("dblclick", this.onDoubleClick);
    this.host.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("black-terminal-layout-resize", this.queueResize);
    this.app.canvas.removeEventListener("webglcontextlost", this.onBclifContextLost);
    this.app.canvas.removeEventListener("webglcontextrestored", this.onBclifContextRestored);
    window.removeEventListener("visibilitychange", this.handleVisibilityChange);
    if (this.resizeRaf) window.cancelAnimationFrame(this.resizeRaf);
    if (this.drawRaf) window.cancelAnimationFrame(this.drawRaf);
    this.host.classList.remove("price-scale-dragging", "price-scale-hover", "drawing-eraser");
    this.setReplaySelectionMode(false);
    this.resizeObserver?.disconnect();
    this.releaseResizeObserver?.();
    this.releaseVisibilityListener?.();
    this.clearDrawingTexts();
    this.clearAlertTexts();
    this.clearProfileTexts();
    this.clearHeatmapTexts();
    this.clearTexts();
    for (const text of this.axisTextPool) text.destroy();
    this.axisTextPool = [];
    this.rootLayer.removeChild(
      this.kioseffRenderer.container,
      this.liquidationFieldRenderer.container,
      this.auctionProfileRenderer.container,
      this.cvdFootprintRenderer.container
    );
    this.kioseffRenderer.dispose();
    this.liquidationFieldRenderer.dispose();
    this.auctionProfileRenderer.dispose();
    this.cvdFootprintRenderer.dispose();
    // PIXI's canvas-text TexturePool is process-global. Passing boolean `true`
    // as renderer options also releases that global pool, leaving still-active
    // text keys from a neighbouring/remounting Application without a bucket.
    // Remove only this canvas; module-owned textures were disposed above.
    this.app.destroy(
      { removeView: true, releaseGlobalResources: false },
      { children: true, texture: false }
    );
    blackCoreResourceTracker.clearGauge("pixi-container", this.resourceOwner);
    blackCoreResourceTracker.clearGauge("pixi-graphics", this.resourceOwner);
    blackCoreResourceTracker.clearGauge("pixi-text", this.resourceOwner);
    blackCoreResourceTracker.clearGauge("pixi-texture", this.resourceOwner);
    blackCoreResourceTracker.clearGauge("pixi-geometry", this.resourceOwner);
  }

  private stopDragging() {
    this.dragging = false;
    this.ddaProDragging = false;
    this.priceScaleDragging = false;
    this.host.classList.remove("price-scale-dragging");
    this.host.classList.remove("dda-pro-dragging");
    if (!this.pointer.active) this.host.classList.remove("dda-pro-scale-hover");
  }

  private setPriceScaleHover(isHovering: boolean) {
    if (this.priceScaleHover === isHovering) return;
    this.priceScaleHover = isHovering;
    this.host.classList.toggle("price-scale-hover", isHovering);
  }

  private isInsidePriceAxis(x: number, y: number) {
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    return x >= plotWidth && x <= this.view.width && y >= this.view.topPadding && y <= plotHeight;
  }

  private isInsidePlot(x: number, y: number) {
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    return x >= 0 && x <= plotWidth && y >= this.view.topPadding && y <= plotHeight;
  }

  private scalePriceAxis(y: number) {
    const startMin = toAxisValue(this.priceScaleDragStartMin, this.priceScaleMode);
    const startMax = toAxisValue(this.priceScaleDragStartMax, this.priceScaleMode);
    if (!Number.isFinite(startMin) || !Number.isFinite(startMax)) return;
    const startRange = startMax - startMin;
    const center = (startMax + startMin) / 2;
    const factor = Math.max(0.08, Math.min(16, Math.exp((y - this.priceScaleDragStartY) * 0.006)));
    const halfRange = (startRange * factor) / 2;

    this.manualPriceRange = {
      min: fromAxisValue(center - halfRange, this.priceScaleMode),
      max: fromAxisValue(center + halfRange, this.priceScaleMode)
    };
    this.queueDraw();
  }

  private panPriceAxis(dy: number) {
    if (Math.abs(dy) < 1) return;
    const plotHeight = this.getPricePlotHeight();
    const startMin = toAxisValue(this.dragStartPriceMin, this.priceScaleMode);
    const startMax = toAxisValue(this.dragStartPriceMax, this.priceScaleMode);
    if (!Number.isFinite(startMin) || !Number.isFinite(startMax)) return;
    const priceDelta = (dy / plotHeight) * (startMax - startMin);

    this.manualPriceRange = {
      min: fromAxisValue(startMin + priceDelta, this.priceScaleMode),
      max: fromAxisValue(startMax + priceDelta, this.priceScaleMode)
    };
  }

  private onDoubleClick = (e: MouseEvent) => {
    const bounds = this.host.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    const ddaPaneBounds = this.ddaProPaneBounds();
    if (
      ddaPaneBounds
      && y >= ddaPaneBounds.top
      && y <= ddaPaneBounds.bottom
      && x >= ddaPaneBounds.plotWidth - 24
    ) {
      e.preventDefault();
      this.ddaProCamera = resetDDAProCamera();
      this.queueDraw();
      return;
    }
    const alertHit = this.hitPriceAlertLine(x, y);
    if (alertHit) {
      e.preventDefault();
      this.onAlertEditRequest?.(alertHit.id);
      return;
    }

    if (!this.isInsidePriceAxis(x, y)) return;

    this.manualPriceRange = undefined;
    this.queueDraw();
  };

  private queueDraw() {
    if (this.destroyed || this.drawRaf || document.visibilityState !== "visible") return;
    this.drawRaf = window.requestAnimationFrame(() => {
      this.drawRaf = undefined;
      if (this.destroyed) return;
      this.draw();
    });
  }

  private handleVisibilityChange = () => {
    if (this.destroyed) return;
    if (document.visibilityState === "visible") {
      this.app.ticker.start();
      this.queueDraw();
    } else {
      this.app.ticker.stop();
      if (this.drawRaf) window.cancelAnimationFrame(this.drawRaf);
      this.drawRaf = undefined;
    }
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();

    const bounds = this.host.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    const ddaPaneBounds = this.ddaProPaneBounds();
    if (
      ddaPaneBounds
      && y >= ddaPaneBounds.top
      && y <= ddaPaneBounds.bottom
      && x >= ddaPaneBounds.plotWidth - 24
    ) {
      const anchorRatio = (y - ddaPaneBounds.top) / Math.max(1, ddaPaneBounds.height);
      this.ddaProCamera = zoomDDAProCamera(this.ddaProCamera, this.ddaProBaseDepth(), e.deltaY, anchorRatio);
      this.queueDraw();
      return;
    }
    const mostlyHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.7;

    if (e.shiftKey || (!e.ctrlKey && mostlyHorizontal)) {
      this.panTimeAxis(e.deltaX + e.deltaY);
    } else {
      const zoomIntensity = e.ctrlKey ? 0.0022 : 0.0017;
      const factor = Math.exp(-e.deltaY * zoomIntensity);
      this.zoomTimeAxis(factor, x);
    }

    this.queueDraw();
  };

  private panTimeAxis(delta: number) {
    this.view.scrollX = this.clampHorizontalScroll(this.view.scrollX + delta * 0.9);
  }

  private zoomTimeAxis(factor: number, anchorX: number) {
    const data = this.getDisplayCandles();
    if (data.length === 0 || !Number.isFinite(factor) || factor <= 0) return;

    const oldStep = this.timeStep();
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const clampedX = Math.max(0, Math.min(plotWidth, anchorX));
    const oldRightAnchor = plotWidth - this.view.candleWidth / 2 - 12;
    const anchorIndex = data.length - 1 - (oldRightAnchor + this.view.scrollX - clampedX) / oldStep;

    this.view.candleWidth = Math.max(MIN_CANDLE_WIDTH, Math.min(MAX_CANDLE_WIDTH, this.view.candleWidth * factor));
    this.view.gap = Math.max(
      MIN_CANDLE_GAP,
      Math.min(MAX_CANDLE_GAP, this.view.candleWidth < 1.4 ? this.view.candleWidth * 0.22 : this.view.candleWidth * 0.38)
    );

    const newStep = this.timeStep();
    const newRightAnchor = plotWidth - this.view.candleWidth / 2 - 12;
    const nextScroll = clampedX - newRightAnchor + (data.length - 1 - anchorIndex) * newStep;
    this.view.scrollX = this.clampHorizontalScroll(nextScroll);
  }

  private clampHorizontalScroll(scrollX: number) {
    const data = this.getDisplayCandles();
    const maxScroll = Math.max(0, (data.length - 1) * this.timeStep());
    const plotWidth = Math.max(0, this.view.width - this.view.rightAxisWidth);
    const minScroll = this.snapToLatest ? 0 : -plotWidth * 0.72;
    return Math.max(minScroll, Math.min(maxScroll, scrollX));
  }

  private queueResize = () => {
    if (this.resizeRaf) window.cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = undefined;
      this.resize();
    });
  };

  private resize() {
    const bounds = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    this.app.renderer.resize(width, height);
    this.app.stage.hitArea = this.app.screen;
    this.view.width = width;
    this.view.height = height;
    this.draw();
  }

  private tickFps() {
    this.frameCount++;
    const now = performance.now();
    const frameDelta = now - this.lastTickerFrameAt;
    this.lastTickerFrameAt = now;
    blackCorePerformanceMonitor.recordFrame(frameDelta, { surface: "pixi-chart" });
    if (now - this.lastFpsTime > 500) {
      const fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
      this.onFps?.(fps);
      blackCorePerformanceMonitor.recordMetric("chart.fps", fps, "fps", { surface: "pixi-chart" });
      blackCoreResourceTracker.setGauge("pixi-texture", this.resourceOwner, 0);
      blackCoreResourceTracker.setGauge("pixi-geometry", this.resourceOwner, 11);
      blackCorePerformanceMonitor.recordMetric("chart.draw_calls", 11, "count", { surface: "pixi-chart" });
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
    
    // Redraw once per second to update the price countdown timer
    const epochSec = Math.floor(Date.now() / 1000);
    if (epochSec !== this.lastCountdownTime) {
      this.lastCountdownTime = epochSec;
      this.draw();
    }
  }

  private getDisplayCandles() {
    return this.displayedCandles.length ? this.displayedCandles : this.candles.all();
  }

  private timeStep() {
    return Math.max(0.05, this.view.candleWidth + this.view.gap);
  }

  private createDisplayCandles(source: Candle[]) {
    if (source.length === 0) return [];

    if (this.chartType === "heikinAshi") {
      return this.toHeikinAshi(source);
    }

    if (this.chartType === "renko") {
      return this.toRenko(source);
    }

    if (this.chartType === "line") {
      return source.map((candle) => ({
        ...candle,
        high: candle.close,
        low: candle.close
      }));
    }

    return source;
  }

  private toHeikinAshi(source: Candle[]) {
    const transformed: Candle[] = [];

    for (const candle of source) {
      const close = (candle.open + candle.high + candle.low + candle.close) / 4;
      const previous = transformed[transformed.length - 1];
      const open = previous ? (previous.open + previous.close) / 2 : (candle.open + candle.close) / 2;
      transformed.push({
        time: candle.time,
        open,
        high: Math.max(candle.high, open, close),
        low: Math.min(candle.low, open, close),
        close,
        volume: candle.volume
      });
    }

    return transformed;
  }

  private toRenko(source: Candle[]) {
    const first = source[0];
    const last = source[source.length - 1];
    if (!first || !last) return [];

    const atr = this.averageTrueRange(source.slice(-160));
    const fallbackSize = Math.max(last.close * 0.0012, 1);
    const brickSize = Math.max(atr * 0.72, fallbackSize);
    const bricks: Candle[] = [];
    let anchor = first.open;
    let volumeBucket = 0;

    for (const candle of source) {
      volumeBucket += candle.volume;
      let diff = candle.close - anchor;
      let guard = 0;

      while (Math.abs(diff) >= brickSize && guard < 80) {
        const direction = diff > 0 ? 1 : -1;
        const open = anchor;
        const close = anchor + direction * brickSize;
        bricks.push({
          time: candle.time,
          open,
          high: Math.max(open, close),
          low: Math.min(open, close),
          close,
          volume: volumeBucket
        });

        if (bricks.length > 12000) bricks.shift();
        anchor = close;
        volumeBucket = 0;
        diff = candle.close - anchor;
        guard++;
      }
    }

    return bricks.length ? bricks : source.slice(-240);
  }

  private averageTrueRange(source: Candle[]) {
    if (source.length < 2) return 0;

    let sum = 0;
    for (let i = 1; i < source.length; i++) {
      const current = source[i];
      const previous = source[i - 1];
      sum += Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
    }

    return sum / (source.length - 1);
  }

  private calculateView() {
    this.displayedCandles = this.createDisplayCandles(this.candles.all());
    const data = this.getDisplayCandles();
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const step = this.timeStep();
    const visibleCount = Math.ceil(plotWidth / step) + 80;
    this.view.scrollX = this.clampHorizontalScroll(this.view.scrollX);
    const lastIndex = Math.max(0, Math.min(data.length - 1, data.length - 1 - Math.floor(this.view.scrollX / step)));
    const firstIndex = Math.max(0, lastIndex - visibleCount);

    const visible = data.slice(firstIndex, lastIndex + 1);
    let min = Math.min(...visible.map(c => c.low));
    let max = Math.max(...visible.map(c => c.high));
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 64000;
      max = 68000;
    }

    const last = data[data.length - 1];
    if (data.length <= 300 && last && last.close > 60000 && last.close < 75000) {
      min = Math.min(min, 64600);
      max = Math.max(max, 67400);
    }

    if (this.visibleIndicators.volatilityHeatmap) {
      const indicatorDomain = kioseffPriceDomain(
        this.kioseffSnapshot,
        this.kioseffSettings,
        min,
        max,
        visible[0]?.time ?? null,
        visible.at(-1)?.time ?? null
      );
      min = indicatorDomain.minimum;
      max = indicatorDomain.maximum;
    }

    if (
      this.visibleIndicators.liquidationHeatmap
      && this.liquidationFieldSnapshot
      && this.liquidationFieldSettings.rangeMode !== "VISIBLE"
      && last
    ) {
      const displayDomain = resolveBclifDisplayDomain(this.liquidationFieldSnapshot, this.liquidationFieldSettings, {
        chartPriceMinimum: min,
        chartPriceMaximum: max,
        currentPrice: last.close
      });
      if (displayDomain) {
        min = displayDomain.minimum;
        max = displayDomain.maximum;
      }
    }

    const pad = (max - min) * 0.035 || 100;
    if (this.manualPriceRange) {
      this.view.priceMin = this.manualPriceRange.min;
      this.view.priceMax = this.manualPriceRange.max;
    } else {
      this.view.priceMin = min - pad;
      this.view.priceMax = max + pad;
    }
    this.view.firstIndex = firstIndex;
    this.view.lastIndex = lastIndex;

    if (firstIndex <= 80 && this.candles.all().length > 0) {
      const oldest = this.candles.all()[0];
      if (oldest) this.onNeedMoreHistory?.(oldest);
    }
  }

  private xForIndex(index: number) {
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const step = this.timeStep();
    const barsFromLatest = this.getDisplayCandles().length - 1 - index;
    return plotWidth - barsFromLatest * step - this.view.candleWidth / 2 - 12 + this.view.scrollX;
  }

  private xForTimestamp(time: number) {
    const candles = this.getDisplayCandles();
    if (!candles.length) return 0;
    let low = 0;
    let high = candles.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (candles[middle]!.time <= time) low = middle + 1;
      else high = middle;
    }
    const leftIndex = low >= candles.length && candles.length > 1
      ? candles.length - 2
      : Math.max(0, low - 1);
    const left = candles[leftIndex]!;
    const right = candles[Math.min(candles.length - 1, leftIndex + 1)]!;
    if (left.time === right.time) return this.xForIndex(leftIndex);
    const fraction = (time - left.time) / (right.time - left.time);
    return this.xForIndex(leftIndex + fraction);
  }

  private getOscillatorPaneHeight() {
    return this.oscillatorStackLayout().reservedHeight;
  }

  private oscillatorStackLayout() {
    const configuredPane = this.indicatorAdvancedSettings.oscillatorPane;
    return resolveOscillatorStack(
      this.visibleIndicators,
      {
        ...defaultOscillatorPaneSettings,
        ...configuredPane,
        paneHeights: {
          ...defaultOscillatorPaneSettings.paneHeights,
          ...(configuredPane?.paneHeights ?? {})
        },
        order: configuredPane?.order ?? defaultOscillatorPaneSettings.order
      },
      {
        ...defaultWaveTrendOscillatorSettings,
        ...(this.indicatorAdvancedSettings.waveTrendOscillator ?? {})
      },
      this.view.height,
      this.view.bottomAxisHeight,
      this.view.topPadding
    );
  }

  private ddaProPaneBounds() {
    if (!this.visibleIndicators.ddaProOscillator) return undefined;
    const pane = this.oscillatorStackLayout().panes.find((candidate) => candidate.key === "ddaProOscillator");
    if (!pane) return undefined;
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const bottom = plotHeight - 16 - pane.bottomOffset;
    const top = bottom - pane.height;
    return { top, bottom, height: pane.height, plotWidth };
  }

  private ddaProBaseDepth(data: Candle[] = this.getDisplayCandles()) {
    const snapshot = this.ddaProSnapshot;
    const settings = this.indicatorAdvancedSettings.ddaProOscillator;
    if (!snapshot || snapshot.inputSize === 0) return 1;
    if (settings.scaleMode === "fixed-10") return 10;
    if (settings.scaleMode === "fixed-20") return 20;
    if (settings.scaleMode === "fixed-50") return 50;
    if (settings.scaleMode === "custom") return settings.customScaleDepthPercent;

    const offset = Math.max(0, data.length - snapshot.inputSize);
    const visibleDrawdowns: number[] = [];
    for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
      const sourceIndex = index - offset;
      const value = sourceIndex >= 0 ? snapshot.series.rawDrawdown[sourceIndex] : undefined;
      if (Number.isFinite(value)) visibleDrawdowns.push(Math.abs(value!));
    }
    return Math.max(
      1,
      Math.min(
        100,
        Math.max(
          ...visibleDrawdowns,
          Math.abs(snapshot.latest.maxDrawdownPercent),
          Math.abs(snapshot.series.p05.at(-1) ?? 0),
          Math.abs(snapshot.series.p99.at(-1) ?? 0),
          1
        ) * 1.12
      )
    );
  }

  private configuredOscillatorPaneHeight() {
    return this.oscillatorStackLayout().panes[0]?.height ?? defaultOscillatorPaneSettings.height;
  }

  private getPricePlotHeight() {
    return Math.max(1, this.view.height - this.view.bottomAxisHeight - this.view.topPadding - this.getOscillatorPaneHeight());
  }

  private yForPrice(price: number) {
    return this.priceToScreenY(price) ?? this.view.topPadding;
  }

  private priceForY(y: number) {
    return this.screenYToPrice(y) ?? this.view.priceMin;
  }

  private indexForX(x: number) {
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const dataLength = this.getDisplayCandles().length;
    const barsFromLatest = (plotWidth - this.view.candleWidth / 2 - 12 + this.view.scrollX - x) / this.timeStep();
    return Math.max(0, Math.min(dataLength - 1, Math.round(dataLength - 1 - barsFromLatest)));
  }

  private drawingPointFromPointer(x: number, y: number): DrawingPoint {
    return {
      index: this.indexForX(x),
      price: this.priceForY(y)
    };
  }

  private drawingPointToXY(point: DrawingPoint) {
    return {
      x: this.xForIndex(point.index),
      y: this.yForPrice(point.price)
    };
  }

  private distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  private drawingHitDistance(drawing: DrawingShape, x: number, y: number) {
    const [a, b] = drawing.points;
    if (!a) return Number.POSITIVE_INFINITY;
    const start = this.drawingPointToXY(a);
    const end = b ? this.drawingPointToXY(b) : start;
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;

    if (drawing.tool === "horizontalLine") return Math.abs(y - start.y);
    if (drawing.tool === "verticalLine") return Math.abs(x - start.x);
    if (drawing.tool === "trendLine" || drawing.tool === "measure") {
      return this.distanceToSegment(x, y, start.x, start.y, end.x, end.y);
    }
    if (drawing.tool === "rectangle") {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);
      if (x >= left && x <= right && y >= top && y <= bottom) {
        return Math.min(Math.abs(x - left), Math.abs(x - right), Math.abs(y - top), Math.abs(y - bottom), 3);
      }
      return Math.min(
        this.distanceToSegment(x, y, left, top, right, top),
        this.distanceToSegment(x, y, right, top, right, bottom),
        this.distanceToSegment(x, y, right, bottom, left, bottom),
        this.distanceToSegment(x, y, left, bottom, left, top)
      );
    }
    if (drawing.tool === "fibonacci") {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x, left + 80);
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      return Math.min(...levels.map((level) => {
        const levelY = start.y + (end.y - start.y) * level;
        return x >= left - 8 && x <= right + 48 ? Math.abs(y - levelY) : Number.POSITIVE_INFINITY;
      }));
    }
    if (drawing.tool === "brush") {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 1; i < drawing.points.length; i++) {
        const prev = this.drawingPointToXY(drawing.points[i - 1]);
        const next = this.drawingPointToXY(drawing.points[i]);
        min = Math.min(min, this.distanceToSegment(x, y, prev.x, prev.y, next.x, next.y));
      }
      return min;
    }
    if (drawing.tool === "text") {
      return x >= start.x - 6 && x <= start.x + 90 && y >= start.y - 26 && y <= start.y + 8
        ? 0
        : Math.hypot(x - start.x, y - start.y);
    }

    return x >= 0 && x <= plotWidth && y >= this.view.topPadding && y <= plotHeight ? Math.hypot(x - start.x, y - start.y) : Number.POSITIVE_INFINITY;
  }

  private eraseDrawingAt(x: number, y: number) {
    const hit = this.drawings
      .map((drawing, index) => ({ drawing, index, distance: this.drawingHitDistance(drawing, x, y) }))
      .filter((entry) => entry.distance <= 10)
      .sort((a, b) => a.distance - b.distance)[0];

    if (hit) {
      this.drawings.splice(hit.index, 1);
      this.draw();
      return true;
    }

    return false;
  }

  private handleDrawingPointerDown(e: FederatedPointerEvent) {
    if (this.drawingsLocked || this.activeDrawingTool === "cursor" || !this.isInsidePlot(e.global.x, e.global.y)) return false;
    const point = this.drawingPointFromPointer(e.global.x, e.global.y);

    if (this.activeDrawingTool === "eraser") {
      this.eraseDrawingAt(e.global.x, e.global.y);
      return true;
    }

    if (this.activeDrawingTool === "horizontalLine" || this.activeDrawingTool === "verticalLine" || this.activeDrawingTool === "text") {
      this.drawings.push({
        id: this.nextDrawingId++,
        tool: this.activeDrawingTool,
        points: [point],
        text: this.activeDrawingTool === "text" ? "Text" : undefined
      });
      this.draw();
      return true;
    }

    if (this.activeDrawingTool === "brush") {
      const drawing: DrawingShape = {
        id: this.nextDrawingId++,
        tool: "brush",
        points: [point]
      };
      this.drawings.push(drawing);
      this.activeBrushId = drawing.id;
      this.draw();
      return true;
    }

    if (!this.draftDrawing || this.draftDrawing.tool !== this.activeDrawingTool) {
      this.draftDrawing = {
        id: this.nextDrawingId++,
        tool: this.activeDrawingTool,
        points: [point, point]
      };
      this.draw();
      return true;
    }

    this.draftDrawing.points[1] = point;
    this.drawings.push(this.draftDrawing);
    this.draftDrawing = undefined;
    this.draw();
    return true;
  }

  private handleReplaySelectionPointerDown(e: FederatedPointerEvent) {
    if (!this.replaySelectionMode || !this.isInsidePlot(e.global.x, e.global.y)) return false;

    const index = this.indexForX(e.global.x);
    const candle = this.getDisplayCandles()[index];
    if (!candle) return true;

    this.replaySelectionMode({
      index,
      time: candle.time,
      price: candle.close
    });
    return true;
  }

  private handleDrawingPointerMove(e: FederatedPointerEvent) {
    if (this.drawingsLocked || this.activeDrawingTool === "cursor" || !this.isInsidePlot(e.global.x, e.global.y)) return false;
    const point = this.drawingPointFromPointer(e.global.x, e.global.y);

    if (this.activeBrushId) {
      const drawing = this.drawings.find((item) => item.id === this.activeBrushId);
      const lastPoint = drawing?.points[drawing.points.length - 1];
      if (drawing && (!lastPoint || Math.abs(lastPoint.index - point.index) > 0 || Math.abs(lastPoint.price - point.price) > (this.view.priceMax - this.view.priceMin) * 0.002)) {
        drawing.points.push(point);
        this.draw();
      }
      return true;
    }

    if (this.draftDrawing && this.draftDrawing.points.length > 1) {
      this.draftDrawing.points[1] = point;
      this.draw();
      return true;
    }

    this.drawCrosshair();
    return true;
  }

  private finishBrushDrawing() {
    this.activeBrushId = undefined;
  }

  private draw() {
    if (this.destroyed) return;
    this.calculateView();
    this.drawGrid();
    this.drawWatermark();
    this.drawHeatmap();
    this.drawIndicators();
    this.drawVolume();
    this.drawCandles();
    this.drawDrawings();
    this.drawPriceAlertLines();
    this.drawAxes();
    this.drawCrosshair();
    this.emitPriceTransformIfChanged();
    blackCoreResourceTracker.setGauge(
      "pixi-text",
      this.resourceOwner,
      this.priceTexts.length + this.timeTexts.length + this.labelTexts.length + this.hudTexts.length
        + this.crosshairTexts.length + this.drawingTexts.length + this.profileTexts.length
        + this.heatmapTexts.length + this.alertTexts.length
    );
  }

  private emitPriceTransformIfChanged() {
    if (!this.onPriceTransformChange) return;
    const snapshot = this.getPriceTransformSnapshot();
    const key = [
      snapshot.width, snapshot.height, snapshot.plotTop, snapshot.plotBottom,
      snapshot.plotRight, snapshot.priceMin, snapshot.priceMax, snapshot.scaleMode,
      snapshot.firstIndex, snapshot.lastIndex
    ].join(":");
    if (key === this.lastPriceTransformKey) return;
    this.lastPriceTransformKey = key;
    this.priceTransformRevision += 1;
    this.onPriceTransformChange({ ...snapshot, revision: this.priceTransformRevision });
  }

  private drawGrid() {
    const g = this.gridLayer;
    g.clear();
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;

    g.rect(0, 0, this.view.width, this.view.height).fill({ color: theme.background });

    g.moveTo(plotWidth, 0).lineTo(plotWidth, this.view.height).stroke({ width: 1, color: 0xffffff, alpha: 0.08 });
    g.moveTo(0, plotHeight).lineTo(this.view.width, plotHeight).stroke({ width: 1, color: 0xffffff, alpha: 0.08 });
  }

  private drawWatermark() {
    const g = this.watermarkLayer;
    g.clear();
  }

  private drawHeatmap() {
    const g = this.heatmapLayer;
    g.clear();
    this.clearHeatmapTexts();
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    this.liquidationFieldRenderer.setState(
      this.visibleIndicators.liquidationHeatmap ? this.liquidationFieldSnapshot : null,
      this.liquidationFieldSettings
    );
    this.liquidationFieldRenderer.draw({
      width: plotWidth,
      height: plotHeight,
      top: this.view.topPadding,
      bottom: plotHeight,
      priceMin: this.view.priceMin,
      priceMax: this.view.priceMax,
      currentPrice: this.getDisplayCandles().at(-1)?.close ?? (this.view.priceMin + this.view.priceMax) / 2,
      constrainedTouchRenderer: this.constrainedTouchRenderer,
      xForTimestampMs: (timestampMs) => this.xForTimestamp(bclifTimestampMsToChartSeconds(timestampMs)),
      yForPrice: (price) => this.yForPrice(price)
    });
    this.kioseffRenderer.draw(
      this.visibleIndicators.volatilityHeatmap ? this.kioseffSnapshot : null,
      this.kioseffSettings,
      {
        width: plotWidth,
        height: plotHeight,
        top: this.view.topPadding,
        xForTime: (time) => this.xForTimestamp(time),
        yForPrice: (price) => this.yForPrice(price)
      }
    );
    const kioseffMetrics = this.kioseffRenderer.metrics();
    const layers = resolveAuctionVisualizationLayers(
      this.visibleIndicators.auctionProfile,
      this.chartType === "volumeFootprint",
      this.auctionProfileSettings.rendering.visualizationType
    );
    const auctionTransform = {
      width: plotWidth,
      height: plotHeight,
      top: this.view.topPadding,
      bottom: plotHeight,
      constrainedTouchRenderer: this.constrainedTouchRenderer,
      xForTime: (time: number) => this.xForTimestamp(time),
      xForLookbackBars: (bars: number) => this.xForIndex(Math.max(0, this.getDisplayCandles().length - Math.max(1, Math.round(bars)))),
      yForPrice: (price: number) => this.yForPrice(price)
    };
    this.cvdFootprintRenderer.draw(
      layers.footprint ? this.auctionProfileSnapshots : null,
      this.auctionProfileSettings,
      auctionTransform
    );
    this.auctionProfileRenderer.draw(
      layers.profile ? this.auctionProfileSnapshots : null,
      this.auctionProfileSettings,
      auctionTransform
    );
    const auctionProfileMetrics = this.auctionProfileRenderer.metrics();
    const footprintMetrics = this.cvdFootprintRenderer.metrics();

    blackCoreResourceTracker.setGauge(
      "pixi-text",
      this.resourceOwner,
      this.priceTexts.length +
        this.timeTexts.length +
        this.labelTexts.length +
        this.hudTexts.length +
        this.profileTexts.length +
        this.heatmapTexts.length +
        kioseffMetrics.textObjects + auctionProfileMetrics.labels + footprintMetrics.labels
    );

  }

  private indicatorColor(color: IndicatorColorKey, fallback = theme.silverBright) {
    const colors: Record<IndicatorColorKey, number> = {
      red: theme.redBright,
      white: theme.text,
      silver: theme.silverBright,
      gray: theme.muted,
      green: theme.green,
      orange: theme.orangeBright
    };
    return colors[color] ?? fallback;
  }

  private hexColor(value: string, fallback: number) {
    const normalized = value.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return fallback;
    return Number.parseInt(normalized, 16);
  }

  private visualFor(key: keyof VisibleIndicators, fallbackColor: IndicatorColorKey) {
    const setting = this.indicatorVisualSettings[key] ?? { color: fallbackColor, intensity: 60 };
    const intensity = Math.max(15, Math.min(100, setting.intensity)) / 100;
    return {
      color: this.indicatorColor(setting.color, this.indicatorColor(fallbackColor)),
      alpha: intensity
    };
  }

  private emaSeries(values: number[], period: number) {
    const smoothing = 2 / (Math.max(1, period) + 1);
    const out: number[] = [];
    let ema = values[0] ?? 0;
    for (let i = 0; i < values.length; i++) {
      const value = values[i] ?? ema;
      ema = i === 0 ? value : value * smoothing + ema * (1 - smoothing);
      out.push(ema);
    }
    return out;
  }

  private vwapSeriesForAlerts(data: Candle[]) {
    return this.institutionalVwap(data).points.map((point) => point.value);
  }

  private institutionalVwap(data: Candle[]) {
    const settings = {
      ...defaultVwapSettings,
      ...this.indicatorAdvancedSettings.vwap
    };
    const last = data[data.length - 1];
    const key = [
      this.volumeProfileDataVersion,
      this.chartType,
      data.length,
      last?.time ?? 0,
      last?.high ?? 0,
      last?.low ?? 0,
      last?.close ?? 0,
      last?.volume ?? 0,
      JSON.stringify(settings)
    ].join("|");
    if (this.institutionalVwapCache?.key === key) return this.institutionalVwapCache.result;
    const result = calculateInstitutionalVwap(data, settings);
    this.institutionalVwapCache = { key, result };
    return result;
  }

  private smaSeries(values: number[], period: number) {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i] ?? 0;
      const dropIndex = i - period;
      if (dropIndex >= 0) sum -= values[dropIndex] ?? 0;
      out.push(sum / Math.min(i + 1, period));
    }
    return out;
  }

  private rmaSeries(values: number[], period: number) {
    const alpha = 1 / Math.max(1, period);
    const out: number[] = [];
    let average = values[0] ?? 0;
    for (let i = 0; i < values.length; i++) {
      const value = values[i] ?? average;
      average = i === 0 ? value : average + alpha * (value - average);
      out.push(average);
    }
    return out;
  }

  private median(values: number[]) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : sorted[middle] ?? 0;
  }

  private oscillatorSourceSeries(data: Candle[]) {
    const source = this.indicatorAdvancedSettings.zScoreOscillator?.source ?? "close";
    return data.map((candle) => {
      if (source === "hl2") return (candle.high + candle.low) / 2;
      if (source === "hlc3") return (candle.high + candle.low + candle.close) / 3;
      if (source === "ohlc4") return (candle.open + candle.high + candle.low + candle.close) / 4;
      return candle.close;
    });
  }

  private openInterestOscillatorSeries(data: Candle[], period: number) {
    const signedFlow = data.map((candle) => {
      const span = Math.max(candle.high - candle.low, candle.close * 0.00001, 1e-8);
      const bodyPressure = Math.max(-1, Math.min(1, (candle.close - candle.open) / span));
      return candle.volume * bodyPressure;
    });
    const fast = this.emaSeries(signedFlow, Math.max(2, period));
    const slow = this.emaSeries(signedFlow, Math.max(3, period * 3));
    const basis = this.emaSeries(signedFlow.map((value) => Math.abs(value)), Math.max(3, period * 3));
    return signedFlow.map((_, index) => {
      const denominator = Math.max(basis[index] ?? 0, 1e-8);
      return Math.max(-120, Math.min(120, ((fast[index] - slow[index]) / denominator) * 100));
    });
  }

  private zScoreOscillatorSeries(data: Candle[], period: number) {
    const settings = this.indicatorAdvancedSettings.zScoreOscillator;
    const safePeriod = Math.max(2, Math.min(500, Math.round(period)));
    const source = this.oscillatorSourceSeries(data);
    const method = settings?.calculationMethod ?? "price";
    const values = source.map((value, index) => {
      if (method === "logReturn") {
        const previous = source[index - 1] ?? value;
        return previous > 0 && value > 0 ? Math.log(value / previous) : 0;
      }
      if (method === "percentReturn") {
        const previous = source[index - 1] ?? value;
        return previous !== 0 ? ((value - previous) / previous) * 100 : 0;
      }
      return value;
    });

    let raw: number[];
    if (method === "robust") {
      raw = new Array(values.length).fill(0);
      const start = Math.max(0, this.view.firstIndex - safePeriod * 2);
      for (let index = start; index < values.length; index++) {
        const sample = values.slice(Math.max(0, index - safePeriod + 1), index + 1);
        const center = this.median(sample);
        const mad = this.median(sample.map((value) => Math.abs(value - center)));
        raw[index] = mad > 1e-12 ? (values[index]! - center) / (mad * 1.4826) : 0;
      }
    } else if ((settings?.basisMethod ?? "sma") === "ema") {
      const mean = this.emaSeries(values, safePeriod);
      const secondMoment = this.emaSeries(values.map((value) => value * value), safePeriod);
      const sampleCorrection = settings?.deviationMode === "sample" && safePeriod > 1
        ? safePeriod / (safePeriod - 1)
        : 1;
      raw = values.map((value, index) => {
        const center = mean[index] ?? value;
        const variance = Math.max(0, (secondMoment[index] ?? value * value) - center * center);
        const deviation = Math.sqrt(variance * sampleCorrection);
        return deviation > 1e-12 ? (value - (mean[index] ?? value)) / deviation : 0;
      });
    } else {
      raw = [];
      let sum = 0;
      let sumSquares = 0;
      for (let index = 0; index < values.length; index++) {
        const value = values[index] ?? 0;
        sum += value;
        sumSquares += value * value;
        const dropIndex = index - safePeriod;
        if (dropIndex >= 0) {
          const dropped = values[dropIndex] ?? 0;
          sum -= dropped;
          sumSquares -= dropped * dropped;
        }
        const count = Math.min(index + 1, safePeriod);
        const mean = sum / Math.max(1, count);
        const divisor = settings?.deviationMode === "sample" ? Math.max(1, count - 1) : Math.max(1, count);
        const variance = Math.max(0, (sumSquares - (sum * sum) / Math.max(1, count)) / divisor);
        const deviation = Math.sqrt(variance);
        raw.push(deviation > 1e-12 ? (value - mean) / deviation : 0);
      }
    }

    const smoothingLength = Math.max(1, Math.min(100, Math.round(settings?.smoothingLength ?? 3)));
    const smoothingMethod = settings?.smoothingMethod ?? "ema";
    const smoothed = smoothingMethod === "sma"
      ? this.smaSeries(raw, smoothingLength)
      : smoothingMethod === "ema"
        ? this.emaSeries(raw, smoothingLength)
        : smoothingMethod === "rma"
          ? this.rmaSeries(raw, smoothingLength)
          : raw;
    const clamp = Math.max(1, Math.min(20, Number(settings?.clamp ?? 5)));
    return smoothed.map((value) => Math.max(-clamp, Math.min(clamp, value)) * 24);
  }

  private waveTrendOscillatorSeries(data: Candle[], channelLength: number) {
    const hlc3 = data.map((candle) => (candle.high + candle.low + candle.close) / 3);
    const esa = this.emaSeries(hlc3, Math.max(2, channelLength));
    const deviation = this.emaSeries(hlc3.map((value, index) => Math.abs(value - esa[index])), Math.max(2, channelLength));
    const ci = hlc3.map((value, index) => {
      const denominator = Math.max(0.015 * (deviation[index] ?? 0), 1e-8);
      return (value - (esa[index] ?? value)) / denominator;
    });
    const wt1 = this.emaSeries(ci, Math.max(3, Math.round(channelLength * 2.1)));
    const wt2 = this.smaSeries(wt1, 4);
    return {
      main: wt1.map((value) => Math.max(-140, Math.min(140, value))),
      signal: wt2.map((value) => Math.max(-140, Math.min(140, value)))
    };
  }

  private drawLegacyOscillatorPane(data: Candle[]) {
    const hasOscillator =
      this.visibleIndicators.openInterestOscillator ||
      this.visibleIndicators.zScoreOscillator ||
      this.visibleIndicators.waveTrendOscillator;
    if (!hasOscillator) return;

    const g = this.indicatorLayer;
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const paneBottom = plotHeight - 16;
    const paneHeight = this.configuredOscillatorPaneHeight();
    const paneTop = Math.max(this.view.topPadding + 22, paneBottom - paneHeight);
    const paneMid = (paneTop + paneBottom) / 2;
    const paneHalf = Math.max(1, (paneBottom - paneTop) / 2);
    const paneSettings = this.indicatorAdvancedSettings.oscillatorPane;
    const zSettings = this.indicatorAdvancedSettings.zScoreOscillator;
    const backgroundColor = this.hexColor(paneSettings?.backgroundColor ?? "#000000", 0x000000);
    const backgroundAlpha = Math.max(0, Math.min(1, Number(paneSettings?.backgroundIntensity ?? 62) / 100));
    const zeroLineColor = this.visibleIndicators.zScoreOscillator
      ? this.hexColor(zSettings?.midlineColor ?? "#8a8a90", theme.muted)
      : this.hexColor(paneSettings?.zeroLineColor ?? "#b8b8bc", theme.silverBright);
    const zeroLineAlpha = Math.max(0, Math.min(1, Number(paneSettings?.zeroLineIntensity ?? 24) / 100));

    g.rect(0, paneTop, plotWidth, paneBottom - paneTop)
      .fill({ color: backgroundColor, alpha: backgroundAlpha })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.055 });
    g.moveTo(0, paneMid).lineTo(plotWidth, paneMid).stroke({ width: 1, color: zeroLineColor, alpha: zeroLineAlpha });

    const series: Array<{
      key: keyof VisibleIndicators;
      label: string;
      values: number[];
      fallbackColor: IndicatorColorKey;
      histogram?: boolean;
      dashed?: boolean;
    }> = [];

    if (this.visibleIndicators.openInterestOscillator) {
      series.push({
        key: "openInterestOscillator",
        label: "OI OSC",
        values: this.openInterestOscillatorSeries(data, this.indicatorPeriods.openInterestOscillator),
        fallbackColor: "red",
        histogram: true
      });
    }

    if (this.visibleIndicators.zScoreOscillator) {
      series.push({
        key: "zScoreOscillator",
        label: "Z-SCORE",
        values: this.zScoreOscillatorSeries(data, this.indicatorPeriods.zScoreOscillator),
        fallbackColor: "white"
      });
    }

    if (this.visibleIndicators.waveTrendOscillator) {
      const wt = this.waveTrendOscillatorSeries(data, this.indicatorPeriods.waveTrendOscillator);
      series.push({
        key: "waveTrendOscillator",
        label: "WT",
        values: wt.main,
        fallbackColor: "silver"
      });
      series.push({
        key: "waveTrendOscillator",
        label: "WT SIG",
        values: wt.signal,
        fallbackColor: "gray",
        dashed: true
      });
    }

    const zUpper = Math.max(Number(zSettings?.upperBand ?? 2), Number(zSettings?.lowerBand ?? -2)) * 24;
    const zLower = Math.min(Number(zSettings?.upperBand ?? 2), Number(zSettings?.lowerBand ?? -2)) * 24;
    const visibleValues = series.flatMap((item) =>
      item.values.slice(this.view.firstIndex, this.view.lastIndex + 1).map((value) => Math.abs(value))
    );
    const maxAbs = Math.max(60, Math.min(288, Math.max(...visibleValues, Math.abs(zUpper), Math.abs(zLower), 1) * 1.16));
    const yForOsc = (value: number) => paneMid - (Math.max(-maxAbs, Math.min(maxAbs, value)) / maxAbs) * paneHalf * 0.88;

    if (this.visibleIndicators.zScoreOscillator) {
      const upperY = yForOsc(zUpper);
      const lowerY = yForOsc(zLower);
      const upperColor = this.hexColor(zSettings?.upperBandColor ?? "#b40020", theme.redBright);
      const lowerColor = this.hexColor(zSettings?.lowerBandColor ?? "#d7d7da", theme.silverBright);
      const bandAlpha = Math.max(0, Math.min(1, Number(zSettings?.bandIntensity ?? 72) / 100));
      if (zSettings?.showBandFill ?? true) {
        const fillAlpha = Math.max(0, Math.min(0.5, Number(zSettings?.bandFillIntensity ?? 9) / 100));
        g.rect(0, paneTop, plotWidth, Math.max(0, upperY - paneTop)).fill({ color: upperColor, alpha: fillAlpha });
        g.rect(0, lowerY, plotWidth, Math.max(0, paneBottom - lowerY)).fill({ color: lowerColor, alpha: fillAlpha });
      }
      g.moveTo(0, upperY).lineTo(plotWidth, upperY).stroke({ width: 1, color: upperColor, alpha: bandAlpha });
      g.moveTo(0, lowerY).lineTo(plotWidth, lowerY).stroke({ width: 1, color: lowerColor, alpha: bandAlpha });
    } else {
      g.moveTo(0, paneTop + paneHalf * 0.5).lineTo(plotWidth, paneTop + paneHalf * 0.5).stroke({ width: 1, color: theme.red, alpha: 0.10 });
      g.moveTo(0, paneBottom - paneHalf * 0.5).lineTo(plotWidth, paneBottom - paneHalf * 0.5).stroke({ width: 1, color: theme.red, alpha: 0.10 });
    }

    for (const item of series) {
      const visual = this.visualFor(item.key, item.fallbackColor);
      if (item.histogram) {
        const barWidth = Math.max(0.5, Math.min(this.timeStep() * 0.76, 5));
        for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
          const value = item.values[i];
          if (!Number.isFinite(value)) continue;
          const x = this.xForIndex(i) - barWidth / 2;
          const y = yForOsc(value);
          g.rect(x, Math.min(y, paneMid), barWidth, Math.max(1, Math.abs(y - paneMid)))
            .fill({ color: value >= 0 ? theme.silverBright : visual.color, alpha: 0.12 + visual.alpha * 0.38 });
        }
        continue;
      }

      let started = false;
      for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
        const value = item.values[i];
        if (!Number.isFinite(value)) continue;
        const x = this.xForIndex(i);
        const y = yForOsc(value);
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
      }

      if (started) {
        const isZScore = item.key === "zScoreOscillator";
        const lineWidth = isZScore
          ? Math.max(0.5, Math.min(4, Number(zSettings?.lineWidth ?? 1.35)))
          : item.dashed ? 1 : 1.35;
        const lineAlpha = isZScore
          ? visual.alpha * Math.max(0, Math.min(1, Number(zSettings?.lineIntensity ?? 82) / 100))
          : item.dashed ? visual.alpha * 0.42 : visual.alpha * 0.78;
        g.stroke({
          width: lineWidth,
          color: visual.color,
          alpha: lineAlpha
        });
      }
    }

    let labelX = 10;
    for (const item of series.filter((entry, index, all) => all.findIndex((candidate) => candidate.label === entry.label) === index)) {
      const visual = this.visualFor(item.key, item.fallbackColor);
      g.rect(labelX, paneTop + 9, Math.max(18, item.label.length * 5.6), 2)
        .fill({ color: visual.color, alpha: visual.alpha * 0.78 });
      labelX += item.label.length * 6 + 22;
    }
  }

  private drawDDAProPane(data: Candle[], paneTop: number, paneBottom: number, plotWidth: number) {
    const snapshot = this.ddaProSnapshot;
    const settings = this.indicatorAdvancedSettings.ddaProOscillator;
    const g = this.indicatorLayer;
    const paneHeight = paneBottom - paneTop;
    const offset = Math.max(0, data.length - (snapshot?.inputSize ?? 0));
    const aligned = (values: readonly number[] | undefined, index: number) => {
      const sourceIndex = index - offset;
      return sourceIndex >= 0 ? values?.[sourceIndex] : undefined;
    };
    const themePalette = (() => {
      const palette = (background: string, primary: string, low: string, moderate: string, high: string, extreme: string, neutral: string, text = "#ffffff") => ({ background, primary, low, moderate, high, extreme, neutral, text });
      switch (settings.theme) {
        case "gold": return palette("#000000", "#ffd700", "#ffa500", "#c0c0c0", "#ff5252", "#ff5252", "#c0c0c0");
        case "edge-tools": return palette("#0a0a0a", "#3b82f6", "#22c55e", "#737373", "#ef4444", "#ef4444", "#737373", "#fafafa");
        case "behavioral": return palette("#000000", "#808080", "#00ff00", "#ffbf00", "#8b0000", "#8b0000", "#ffbf00");
        case "quant": return palette("#000000", "#808080", "#ffa500", "#4682b4", "#8b0000", "#8b0000", "#4682b4");
        case "ocean": return palette("#001f3f", "#20b2aa", "#00ced1", "#87ceeb", "#ff4500", "#ff4500", "#87ceeb", "#f0f8ff");
        case "fire": return palette("#2f1b14", "#ff6347", "#ffd700", "#ffa500", "#8b0000", "#8b0000", "#ffa500", "#fffaf0");
        case "matrix": return palette("#0d1b0d", "#00ff41", "#39ff14", "#00ffff", "#ff073a", "#ff073a", "#00ffff", "#c0ff8c");
        case "arctic": return palette("#191970", "#87cefa", "#00bfff", "#b0e0e6", "#ff1493", "#ff1493", "#b0e0e6", "#f8f8ff");
        case "black-terminal-blood": return palette("#020203", "#ff1838", "#d2d3d6", "#6f1118", "#b4001d", "#ff1838", "#777b83");
        case "institutional-monochrome": return palette("#020203", "#f2f2f4", "#d2d3d6", "#666970", "#a0a2a7", "#ffffff", "#777b83");
        case "custom": return palette("#020203", settings.smoothedColor, "#d2d3d6", settings.moderateColor, settings.highColor, settings.extremeColor, settings.meanColor);
        default: return palette("#020203", settings.smoothedColor, "#d2d3d6", settings.moderateColor, settings.highColor, settings.extremeColor, settings.meanColor);
      }
    })();
    const background = this.hexColor(themePalette.background, 0x020203);
    g.rect(0, paneTop, plotWidth, paneHeight)
      .fill({ color: background, alpha: 0.96 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.07 });

    if (!snapshot || snapshot.inputSize === 0) {
      this.addProfileText("DDA PRO · CALCULATING DISTRIBUTION", 12, paneTop + 12, theme.muted, 9, "700");
      return;
    }

    const maxDepth = this.ddaProBaseDepth(data);
    const displayDomain = ddaProDomain(maxDepth, this.ddaProCamera);
    const yForDrawdown = (value: number) => ddaProValueToY(value, paneTop, paneBottom, displayDomain);
    const riskColor = snapshot.latest.riskState === "EXTREME" ? this.hexColor(themePalette.extreme, theme.redBright)
      : snapshot.latest.riskState === "HIGH" ? this.hexColor(themePalette.high, theme.red)
        : snapshot.latest.riskState === "MODERATE" ? this.hexColor(themePalette.moderate, theme.red)
          : this.hexColor(themePalette.low, theme.silver);
    const fillAlpha = Math.max(0, Math.min(0.5, settings.fillIntensity / 100));
    if (snapshot.latest.riskState !== "LOW") {
      g.rect(0, paneTop, plotWidth, paneHeight).fill({ color: riskColor, alpha: fillAlpha * 0.36 });
    }
    g.moveTo(0, yForDrawdown(0)).lineTo(plotWidth, yForDrawdown(0)).stroke({ width: 1, color: theme.silver, alpha: 0.22 });
    for (let tick = 0; tick <= 4; tick++) {
      const value = displayDomain.max - displayDomain.range * (tick / 4);
      const y = yForDrawdown(value);
      g.moveTo(plotWidth - 5, y).lineTo(plotWidth, y).stroke({ width: 1, color: theme.silver, alpha: 0.32 });
      this.addProfileText(value.toFixed(Math.abs(value) >= 10 ? 1 : 2) + "%", plotWidth + 7, y - 5, theme.muted, 8, "500");
    }

    const drawLine = (values: readonly number[], color: number, alpha: number, width: number) => {
      let started = false;
      for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
        const value = aligned(values, index);
        if (!Number.isFinite(value)) { started = false; continue; }
        const x = this.xForIndex(index);
        const y = yForDrawdown(value!);
        if (!started) { g.moveTo(x, y); started = true; }
        else g.lineTo(x, y);
      }
      if (started) g.stroke({ width, color, alpha });
    };

    const drawBand = (upperValues: readonly number[], lowerValues: readonly number[], color: number, alpha: number) => {
      const upper: number[] = [];
      const lower: number[] = [];
      for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
        const upperValue = aligned(upperValues, index);
        const lowerValue = aligned(lowerValues, index);
        if (!Number.isFinite(upperValue) || !Number.isFinite(lowerValue)) continue;
        upper.push(this.xForIndex(index), yForDrawdown(upperValue!));
        lower.unshift(yForDrawdown(lowerValue!));
        lower.unshift(this.xForIndex(index));
      }
      if (upper.length >= 4 && lower.length >= 4) g.poly([...upper, ...lower]).fill({ color, alpha });
    };
    const quantileBands = snapshot.engineMode === "pine-compatibility"
      ? [snapshot.series.p99, snapshot.series.p95, snapshot.series.p90, snapshot.series.p75, snapshot.series.p50, snapshot.series.p25, snapshot.series.p10, snapshot.series.p05]
      : [snapshot.series.p05, snapshot.series.p10, snapshot.series.p25, snapshot.series.p50, snapshot.series.p75, snapshot.series.p90, snapshot.series.p95, snapshot.series.p99];
    const quantileColors = [
      this.hexColor(themePalette.low, theme.silver),
      this.hexColor(themePalette.low, theme.silver),
      this.hexColor(themePalette.neutral, theme.muted),
      this.hexColor(themePalette.neutral, theme.muted),
      this.hexColor(themePalette.moderate, theme.red),
      this.hexColor(themePalette.high, theme.red),
      this.hexColor(themePalette.extreme, theme.redBright),
      this.hexColor(themePalette.extreme, theme.redBright)
    ];
    if (settings.showQuantiles) {
      for (let band = 0; band < quantileBands.length - 1; band++) {
        drawBand(quantileBands[band]!, quantileBands[band + 1]!, quantileColors[band + 1]!, fillAlpha * (0.18 + band * 0.075));
      }
      for (let band = 0; band < quantileBands.length; band++) {
        drawLine(quantileBands[band]!, quantileColors[band]!, 0.22 + band * 0.065, band === quantileBands.length - 1 ? 1.1 : 0.75);
      }
    }

    if (settings.showSigmaBands) {
      const encodedMultiplier = snapshot.engineMode === "pine-compatibility" ? 1 : Math.max(0.25, settings.sigmaMultiplier);
      const sigmaUnit = snapshot.series.mean.map((mean, index) => {
        const lower = snapshot.series.sigmaLower[index];
        return Number.isFinite(mean) && Number.isFinite(lower) ? Math.abs(mean - lower!) / encodedMultiplier : Number.NaN;
      });
      const sigmaLine = (multiplier: number, direction: -1 | 1) => snapshot.series.mean.map((mean, index) => {
        const unit = sigmaUnit[index];
        if (!Number.isFinite(mean) || !Number.isFinite(unit)) return Number.NaN;
        const value = mean + direction * unit! * multiplier;
        return direction > 0 && settings.downsideOnlySigma ? Math.min(0, value) : value;
      });
      const lower1 = sigmaLine(1, -1);
      const lower2 = sigmaLine(2, -1);
      const lower3 = sigmaLine(3, -1);
      const upper1 = sigmaLine(1, 1);
      const upper2 = sigmaLine(2, 1);
      const upper3 = sigmaLine(3, 1);
      drawBand(lower1, lower2, this.hexColor(themePalette.primary, theme.silver), fillAlpha * 0.24);
      drawBand(lower2, lower3, this.hexColor(themePalette.neutral, theme.muted), fillAlpha * 0.18);
      drawLine(lower1, this.hexColor(themePalette.primary, theme.silverBright), 0.34, 0.72);
      drawLine(lower2, this.hexColor(themePalette.neutral, theme.silver), 0.32, 0.76);
      drawLine(lower3, this.hexColor(themePalette.extreme, theme.redBright), 0.42, 0.9);
      if (!settings.downsideOnlySigma) {
        drawBand(upper2, upper1, this.hexColor(themePalette.primary, theme.silver), fillAlpha * 0.24);
        drawBand(upper3, upper2, this.hexColor(themePalette.neutral, theme.muted), fillAlpha * 0.18);
        drawLine(upper1, this.hexColor(themePalette.primary, theme.silverBright), 0.30, 0.72);
        drawLine(upper2, this.hexColor(themePalette.neutral, theme.silver), 0.28, 0.76);
        drawLine(upper3, this.hexColor(themePalette.extreme, theme.redBright), 0.36, 0.9);
      }
    }
    if (settings.showMean) drawLine(snapshot.series.mean, this.hexColor(themePalette.neutral, theme.muted), 0.54, 0.9);
    if (settings.showRawDrawdown) drawLine(snapshot.series.rawDrawdown, this.hexColor(themePalette.neutral, theme.muted), 0.46, 0.8);
    if (settings.showSmoothedDrawdown) {
      drawLine(snapshot.series.smoothedDrawdown, this.hexColor(themePalette.primary, theme.silverBright), settings.lineIntensity / 100, settings.lineWidth);
    }

    if (settings.showRiskScore) {
      const barWidth = Math.max(0.5, Math.min(this.timeStep() * 0.65, 4));
      for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
        const score = aligned(snapshot.series.riskScore, index);
        if (!Number.isFinite(score)) continue;
        const height = Math.max(1, paneHeight * 0.10 * (score! / 100));
        g.rect(this.xForIndex(index) - barWidth / 2, paneBottom - height, barWidth, height)
          .fill({ color: score! >= 90 ? this.hexColor(themePalette.extreme, theme.redBright) : score! >= 75 ? this.hexColor(themePalette.high, theme.red) : this.hexColor(themePalette.moderate, theme.silver), alpha: 0.34 });
      }
    }

    if (settings.showVelocity) drawLine(snapshot.series.velocity.map((value) => -Math.max(0, value)), this.hexColor(themePalette.extreme, theme.redBright), 0.48, 0.75);
    const latestChartIndex = offset + snapshot.inputSize - 1;
    if (latestChartIndex >= this.view.firstIndex && latestChartIndex <= this.view.lastIndex) {
      const current = snapshot.series.smoothedDrawdown.at(-1) ?? snapshot.latest.drawdownPercent;
      g.circle(this.xForIndex(latestChartIndex), yForDrawdown(current), 3.4).fill({ color: riskColor, alpha: 0.98 }).stroke({ width: 1, color: theme.silverBright, alpha: 0.85 });
    }
    if (settings.showEpisodeMarkers) {
      for (const episode of snapshot.episodes) {
        const troughIndex = offset + episode.troughIndex;
        if (troughIndex >= this.view.firstIndex && troughIndex <= this.view.lastIndex) {
          g.circle(this.xForIndex(troughIndex), yForDrawdown(-(snapshot.series.depth[episode.troughIndex] ?? 0)), 2.8).fill({ color: this.hexColor(themePalette.extreme, theme.redBright), alpha: 0.9 });
        }
        if (episode.recoveryIndex !== null) {
          const recoveryIndex = offset + episode.recoveryIndex;
          if (recoveryIndex >= this.view.firstIndex && recoveryIndex <= this.view.lastIndex) {
            g.circle(this.xForIndex(recoveryIndex), yForDrawdown(snapshot.series.rawDrawdown[episode.recoveryIndex] ?? 0), 2.8).fill({ color: this.hexColor(themePalette.low, theme.silverBright), alpha: 0.9 });
          }
        }
      }
    }

    const dashboardOnLeft = settings.dashboardPosition.endsWith("left");
    const dashboardOnBottom = settings.dashboardPosition.startsWith("bottom");
    const dashboardX = dashboardOnLeft ? 12 : Math.max(230, plotWidth - 340);
    const dashboardY = dashboardOnBottom
      ? Math.max(paneTop + 24, paneBottom - (settings.showExpandedDashboard ? 112 : 40))
      : dashboardOnLeft ? paneTop + 24 : paneTop + 7;
    const dashboardTextColor = this.hexColor(themePalette.neutral, theme.muted);
    this.addProfileText(`DDA PRO · ${snapshot.engineMode === "pine-compatibility" ? "PINE COMPAT" : "BLACK CORE NATIVE"}`, 12, paneTop + 7, this.hexColor(themePalette.text, theme.silverBright), 9, "700");
    if (settings.showDashboard) this.addProfileText(`${snapshot.latest.riskState} ${snapshot.latest.riskScore.toFixed(1)} · DD ${snapshot.latest.drawdownPercent.toFixed(2)}% · MDD ${snapshot.latest.maxDrawdownPercent.toFixed(2)}%`, dashboardX, dashboardY, riskColor, 9, "700");
    if (settings.showDashboard && paneHeight >= 145) {
      this.addProfileText("PCTL " + snapshot.latest.percentileRank.toFixed(1) + "   Z " + snapshot.latest.zScore.toFixed(2) + "   TUW " + snapshot.latest.timeUnderWaterBars, dashboardX, dashboardY + 13, dashboardTextColor, 8, "500");
      this.addProfileText("SH " + snapshot.latest.sharpe.toFixed(2) + "   SO " + snapshot.latest.sortino.toFixed(2) + "   CA " + snapshot.latest.calmar.toFixed(2) + "   CONF " + snapshot.latest.confidence.toFixed(0) + "%", dashboardX, dashboardY + 26, dashboardTextColor, 8, "500");
      if (settings.showExpandedDashboard) {
        const latestIndex = Math.max(0, snapshot.inputSize - 1);
        this.addProfileText("P95 " + Math.abs(snapshot.series.p95[latestIndex] ?? 0).toFixed(2) + "%   P99 " + Math.abs(snapshot.series.p99[latestIndex] ?? 0).toFixed(2) + "%   VADD " + snapshot.latest.vadd.toFixed(2), dashboardX, dashboardY + 39, dashboardTextColor, 8, "500");
        this.addProfileText("VaR95 " + snapshot.latest.returnVaR95Percent.toFixed(2) + "%   ES95 " + snapshot.latest.returnES95Percent.toFixed(2) + "%", dashboardX, dashboardY + 52, dashboardTextColor, 8, "500");
        this.addProfileText("DaR95 " + snapshot.latest.drawdownAtRisk95Percent.toFixed(2) + "%   CDaR95 " + snapshot.latest.conditionalDrawdownAtRisk95Percent.toFixed(2) + "%", dashboardX, dashboardY + 65, dashboardTextColor, 8, "500");
        this.addProfileText("ULCER " + snapshot.latest.ulcerIndex.toFixed(2) + "   PAIN " + snapshot.latest.painIndex.toFixed(2) + "   OMEGA " + snapshot.latest.omegaRatio.toFixed(2), dashboardX, dashboardY + 78, dashboardTextColor, 8, "500");
        this.addProfileText("RECOVERY " + snapshot.latest.recoveryFactor.toFixed(2) + "   AUW " + (snapshot.episodes.at(-1)?.areaUnderWater.toFixed(2) ?? "0.00"), dashboardX, dashboardY + 91, dashboardTextColor, 8, "500");
      }
    }
  }

  private drawOscillatorPanes(data: Candle[]) {
    const stack = this.oscillatorStackLayout();
    if (stack.panes.length === 0) return;

    const g = this.indicatorLayer;
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const basePaneBottom = plotHeight - 16;
    const paneSettings = {
      ...defaultOscillatorPaneSettings,
      ...(this.indicatorAdvancedSettings.oscillatorPane ?? {})
    };
    const zSettings = this.indicatorAdvancedSettings.zScoreOscillator;
    const waveSettings = {
      ...defaultWaveTrendOscillatorSettings,
      ...(this.indicatorAdvancedSettings.waveTrendOscillator ?? {})
    };
    const backgroundColor = this.hexColor(paneSettings.backgroundColor, 0x000000);
    const backgroundAlpha = Math.max(0, Math.min(1, Number(paneSettings.backgroundIntensity) / 100));
    const genericZeroColor = this.hexColor(paneSettings.zeroLineColor, theme.silverBright);
    const zeroLineAlpha = Math.max(0, Math.min(1, Number(paneSettings.zeroLineIntensity) / 100));
    const waveTrend = this.visibleIndicators.waveTrendOscillator
      ? this.waveTrendOscillatorSeries(data, this.indicatorPeriods.waveTrendOscillator)
      : undefined;

    for (const pane of stack.panes) {
      const paneBottom = basePaneBottom - pane.bottomOffset;
      const paneTop = paneBottom - pane.height;
      const paneMid = (paneTop + paneBottom) / 2;
      const paneHalf = Math.max(1, pane.height / 2);
      if (pane.key === "ddaProOscillator") {
        this.drawDDAProPane(data, paneTop, paneBottom, plotWidth);
        continue;
      }
      const isZScorePane = pane.key === "zScoreOscillator";
      const zeroLineColor = isZScorePane
        ? this.hexColor(zSettings?.midlineColor ?? "#8a8a90", theme.muted)
        : genericZeroColor;

      g.rect(0, paneTop, plotWidth, pane.height)
        .fill({ color: backgroundColor, alpha: backgroundAlpha })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.055 });
      g.moveTo(0, paneMid).lineTo(plotWidth, paneMid).stroke({
        width: 1,
        color: zeroLineColor,
        alpha: zeroLineAlpha
      });

      const series: Array<{
        key: "openInterestOscillator" | "zScoreOscillator" | "waveTrendOscillator" | "ddaProOscillator";
        label: string;
        values: number[];
        fallbackColor: IndicatorColorKey;
        histogram?: boolean;
        colorOverride?: number;
        alphaOverride?: number;
        widthOverride?: number;
      }> = [];

      if (pane.key === "openInterestOscillator") {
        series.push({
          key: pane.key,
          label: "OI OSC",
          values: this.openInterestOscillatorSeries(data, this.indicatorPeriods.openInterestOscillator),
          fallbackColor: "red",
          histogram: true
        });
      } else if (isZScorePane) {
        series.push({
          key: pane.key,
          label: "Z-SCORE",
          values: this.zScoreOscillatorSeries(data, this.indicatorPeriods.zScoreOscillator),
          fallbackColor: "white"
        });
      }

      const includesWave = pane.key === "waveTrendOscillator" || stack.injectionTarget === pane.key;
      if (includesWave && waveTrend) {
        series.push({
          key: "waveTrendOscillator",
          label: stack.injectionTarget === pane.key ? "WT INJECT" : "WT",
          values: waveTrend.main,
          fallbackColor: "silver",
          widthOverride: Math.max(0.5, Math.min(4, Number(waveSettings.mainLineWidth)))
        });
        series.push({
          key: "waveTrendOscillator",
          label: "WT SIGNAL",
          values: waveTrend.signal,
          fallbackColor: "gray",
          colorOverride: this.hexColor(waveSettings.signalColor, theme.muted),
          alphaOverride: Math.max(0, Math.min(1, Number(waveSettings.signalIntensity) / 100)),
          widthOverride: Math.max(0.5, Math.min(4, Number(waveSettings.signalLineWidth)))
        });
      }

      const zUpper = Math.max(Number(zSettings?.upperBand ?? 2), Number(zSettings?.lowerBand ?? -2)) * 24;
      const zLower = Math.min(Number(zSettings?.upperBand ?? 2), Number(zSettings?.lowerBand ?? -2)) * 24;
      const visibleValues = series.flatMap((item) =>
        item.values.slice(this.view.firstIndex, this.view.lastIndex + 1).map((value) => Math.abs(value))
      );
      const scaleReferences = isZScorePane
        ? [...visibleValues, Math.abs(zUpper), Math.abs(zLower), 1]
        : [...visibleValues, 1];
      const maxAbs = Math.max(60, Math.min(288, Math.max(...scaleReferences) * 1.16));
      const yForOsc = (value: number) =>
        paneMid - (Math.max(-maxAbs, Math.min(maxAbs, value)) / maxAbs) * paneHalf * 0.88;

      if (isZScorePane) {
        const upperY = yForOsc(zUpper);
        const lowerY = yForOsc(zLower);
        const upperColor = this.hexColor(zSettings?.upperBandColor ?? "#b40020", theme.redBright);
        const lowerColor = this.hexColor(zSettings?.lowerBandColor ?? "#d7d7da", theme.silverBright);
        const bandAlpha = Math.max(0, Math.min(1, Number(zSettings?.bandIntensity ?? 72) / 100));
        if (zSettings?.showBandFill ?? true) {
          const fillAlpha = Math.max(0, Math.min(0.5, Number(zSettings?.bandFillIntensity ?? 9) / 100));
          g.rect(0, paneTop, plotWidth, Math.max(0, upperY - paneTop)).fill({ color: upperColor, alpha: fillAlpha });
          g.rect(0, lowerY, plotWidth, Math.max(0, paneBottom - lowerY)).fill({ color: lowerColor, alpha: fillAlpha });
        }
        g.moveTo(0, upperY).lineTo(plotWidth, upperY).stroke({ width: 1, color: upperColor, alpha: bandAlpha });
        g.moveTo(0, lowerY).lineTo(plotWidth, lowerY).stroke({ width: 1, color: lowerColor, alpha: bandAlpha });
      } else {
        g.moveTo(0, paneTop + paneHalf * 0.5).lineTo(plotWidth, paneTop + paneHalf * 0.5)
          .stroke({ width: 1, color: theme.red, alpha: 0.10 });
        g.moveTo(0, paneBottom - paneHalf * 0.5).lineTo(plotWidth, paneBottom - paneHalf * 0.5)
          .stroke({ width: 1, color: theme.red, alpha: 0.10 });
      }

      for (const item of series) {
        const visual = this.visualFor(item.key, item.fallbackColor);
        const itemColor = item.colorOverride ?? visual.color;
        const itemAlpha = item.alphaOverride ?? visual.alpha;
        if (item.histogram) {
          const barWidth = Math.max(0.5, Math.min(this.timeStep() * 0.76, 5));
          for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
            const value = item.values[i];
            if (!Number.isFinite(value)) continue;
            const x = this.xForIndex(i) - barWidth / 2;
            const y = yForOsc(value);
            g.rect(x, Math.min(y, paneMid), barWidth, Math.max(1, Math.abs(y - paneMid)))
              .fill({ color: value >= 0 ? theme.silverBright : itemColor, alpha: 0.12 + itemAlpha * 0.38 });
          }
          continue;
        }

        let started = false;
        for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
          const value = item.values[i];
          if (!Number.isFinite(value)) continue;
          const x = this.xForIndex(i);
          const y = yForOsc(value);
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else {
            g.lineTo(x, y);
          }
        }

        if (started) {
          const isZScore = item.key === "zScoreOscillator";
          const lineWidth = item.widthOverride ?? (isZScore
            ? Math.max(0.5, Math.min(4, Number(zSettings?.lineWidth ?? 1.35)))
            : 1.35);
          const lineAlpha = item.alphaOverride ?? (isZScore
            ? visual.alpha * Math.max(0, Math.min(1, Number(zSettings?.lineIntensity ?? 82) / 100))
            : visual.alpha * 0.78);
          g.stroke({ width: lineWidth, color: itemColor, alpha: lineAlpha });
        }
      }

      let labelX = 10;
      for (const item of series) {
        const visual = this.visualFor(item.key, item.fallbackColor);
        g.rect(labelX, paneTop + 9, Math.max(18, item.label.length * 5.6), 2)
          .fill({
            color: item.colorOverride ?? visual.color,
            alpha: item.alphaOverride ?? visual.alpha * 0.78
          });
        labelX += item.label.length * 6 + 22;
      }
    }
  }

  private drawVolumeProfile(g: Graphics, data: Candle[]) {
    const settings = this.indicatorAdvancedSettings.volumeProfile;
    const result = this.getVolumeProfileResult(data, settings);
    if (!result) return;
    this.lastVolumeProfileResult = result;
    this.lastVolumeProfileHdlxByIndex = new Map(result.hdlx.map((point) => [point.index, point.value]));

    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const rangeLeft = Math.max(0, Math.min(plotWidth, this.xForIndex(result.startIndex)));
    const rangeRight = Math.max(0, Math.min(plotWidth, this.xForIndex(result.endIndex)));
    const leftX = Math.min(rangeLeft, rangeRight);
    const rightX = Math.max(rangeLeft, rangeRight);
    const topY = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(result.profileHigh)));
    const bottomY = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(result.profileLow)));
    const profileTop = Math.min(topY, bottomY);
    const profileBottom = Math.max(topY, bottomY);
    const visibleRangeWidth = Math.max(1, rightX - leftX);
    const profileWidth = Math.max(
      58,
      Math.min(
        plotWidth * 0.42,
        Math.min(360, result.endIndex - result.startIndex + 1) * this.timeStep() * (Math.max(0, settings.widthPercent) / 100)
      )
    );
    const offsetPx = Math.max(0, Math.min(50, settings.horizontalOffset)) * Math.max(1, Math.min(4, this.timeStep()));
    const rightPlacement = settings.placement === "right";
    const baseX = rightPlacement
      ? Math.max(profileWidth + 10, Math.min(plotWidth - 8, rightX + offsetPx))
      : Math.min(plotWidth - profileWidth - 10, Math.max(8, leftX - offsetPx));
    const maxVolume = Math.max(...result.rows.map((row) => row.totalVolume), 1);
    const visual = this.visualFor("volumeProfile", "red");

    if (settings.showProfileBackground) {
      g.rect(leftX, profileTop, visibleRangeWidth, Math.max(1, profileBottom - profileTop))
        .fill({ color: this.hexColor(settings.profileBackgroundColor, 0x2962ff), alpha: 0.045 });
    }

    if (settings.showValueAreaBackground) {
      const vaTop = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(result.valueAreaHigh)));
      const vaBottom = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(result.valueAreaLow)));
      g.rect(leftX, Math.min(vaTop, vaBottom), visibleRangeWidth, Math.max(1, Math.abs(vaBottom - vaTop)))
        .fill({ color: this.hexColor(settings.valueAreaBackgroundColor, 0x2962ff), alpha: 0.055 });
    }

    if (settings.showSupplyDemandZones) {
      this.drawVolumeProfileZones(g, result.rows, leftX, rightX, plotHeight);
    }

    if (settings.showProfileGaps) {
      this.drawVolumeProfileGaps(g, result.rows, leftX, rightX, plotHeight);
    }

    if (settings.showVolumeProfile || settings.showSentimentProfile) {
      for (const row of result.rows) {
        this.drawVolumeProfileRow(g, row, maxVolume, profileWidth, baseX, rightPlacement, plotHeight, settings, visual.alpha);
      }
    }

    this.drawVolumeProfileLevels(g, result, leftX, baseX, rightPlacement, settings);
    if (settings.hdlxOscillator) {
      this.drawHdlxOverlay(g, result, leftX, rightX, profileTop, profileBottom, settings);
    }
    if (settings.showPriceLevels) {
      this.drawVolumeProfilePriceLabels(result, baseX, profileWidth, rightPlacement, settings);
    }
    if (settings.showProfileStats) {
      this.drawVolumeProfileStats(g, result, settings, plotWidth, plotHeight);
    }
  }

  private getVolumeProfileResult(data: Candle[], settings: VolumeProfileSettings) {
    const fixedWindow = this.resolveVolumeProfileFixedWindow(data, settings);
    const endIndex = fixedWindow
      ? fixedWindow.endIndex
      : Math.max(0, Math.min(data.length - 1, this.view.lastIndex));
    const startIndex = fixedWindow
      ? fixedWindow.startIndex
      : Math.max(0, Math.min(this.view.firstIndex, endIndex));
    const start = data[startIndex];
    const end = data[endIndex];
    const key = [
      this.volumeProfileDataVersion,
      settings.rangeMode,
      startIndex,
      endIndex,
      start?.time ?? 0,
      start?.open ?? 0,
      start?.high ?? 0,
      start?.low ?? 0,
      start?.close ?? 0,
      start?.volume ?? 0,
      end?.time ?? 0,
      end?.open ?? 0,
      end?.high ?? 0,
      end?.low ?? 0,
      end?.close ?? 0,
      end?.volume ?? 0,
      this.volumeProfileCalculationKey(settings)
    ].join("|");

    if (this.volumeProfileCache?.key === key) return this.volumeProfileCache.result;

    const result = this.volumeProfileModel.calculate(data, this.view.firstIndex, this.view.lastIndex, settings, fixedWindow);
    this.volumeProfileCache = { key, result };
    return result;
  }

  private resolveVolumeProfileFixedWindow(data: Candle[], settings: VolumeProfileSettings) {
    if (settings.rangeMode !== "fixed" || data.length === 0) return undefined;

    const rangeLength = Math.max(10, Math.min(20000, Math.round(settings.fixedRangeLength)));
    const key = `${rangeLength}:${settings.fixedRangeResetToken}`;
    if (!this.fixedVolumeProfileRange || this.fixedVolumeProfileRange.key !== key) {
      const endIndex = data.length - 1;
      const startIndex = Math.max(0, endIndex - rangeLength + 1);
      this.fixedVolumeProfileRange = {
        key,
        startTime: data[startIndex]?.time ?? data[0]?.time ?? 0,
        endTime: data[endIndex]?.time ?? data[data.length - 1]?.time ?? 0
      };
    }

    const startIndex = this.indexForTimeInData(data, this.fixedVolumeProfileRange.startTime);
    const endIndex = this.indexForTimeInData(data, this.fixedVolumeProfileRange.endTime);
    return {
      startIndex: Math.max(0, Math.min(startIndex, endIndex)),
      endIndex: Math.max(0, Math.max(startIndex, endIndex))
    };
  }

  private indexForTimeInData(data: Candle[], time: number) {
    if (data.length === 0) return 0;
    let low = 0;
    let high = data.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candle = data[mid];
      if (!candle) break;
      if (candle.time < time) low = mid + 1;
      else high = mid - 1;
    }

    const upper = Math.max(0, Math.min(data.length - 1, low));
    const lower = Math.max(0, Math.min(data.length - 1, high));
    const upperDistance = Math.abs((data[upper]?.time ?? time) - time);
    const lowerDistance = Math.abs((data[lower]?.time ?? time) - time);
    return upperDistance < lowerDistance ? upper : lower;
  }

  private volumeProfileCalculationKey(settings: VolumeProfileSettings) {
    const hdlxNeeded = settings.hdlxOscillator || settings.hdlxEnableBarColoring;
    return [
      settings.rangeMode,
      Math.round(settings.fixedRangeLength),
      settings.fixedRangeResetToken,
      Math.round(settings.rows),
      settings.polarityMethod,
      settings.valueAreaPercent,
      settings.supplyDemandThreshold,
      settings.nodeDetectionPercent,
      settings.profileGapIntensity,
      hdlxNeeded ? 1 : 0,
      settings.hdlxPriceSource,
      Math.round(settings.hdlxLookback),
      Math.round(settings.hdlxSmooth)
    ].join(":");
  }

  private drawVolumeProfileZones(g: Graphics, rows: VolumeProfileRow[], leftX: number, rightX: number, plotHeight: number) {
    const configuredIntensity = Number(this.indicatorAdvancedSettings.volumeProfile.supplyDemandIntensity ?? 60);
    const intensity = Math.max(0, Math.min(100, Number.isFinite(configuredIntensity) ? configuredIntensity : 60)) / 100;
    const supplyAlpha = 0.04 + intensity * 0.28;
    const demandAlpha = 0.035 + intensity * 0.235;
    for (const row of rows) {
      if (!row.supplyDemand) continue;
      const yHigh = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceHigh)));
      const yLow = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceLow)));
      const y = Math.min(yHigh, yLow);
      const height = Math.max(1, Math.abs(yLow - yHigh));
      const color = row.supplyDemand === "supply"
        ? this.hexColor(this.indicatorAdvancedSettings.volumeProfile.supplyZoneColor, theme.redBright)
        : this.hexColor(this.indicatorAdvancedSettings.volumeProfile.demandZoneColor, 0x0094ff);
      g.rect(leftX, y, Math.max(1, rightX - leftX), height).fill({ color, alpha: row.supplyDemand === "supply" ? supplyAlpha : demandAlpha });
    }
  }

  private drawVolumeProfileGaps(g: Graphics, rows: VolumeProfileRow[], leftX: number, rightX: number, plotHeight: number) {
    const settings = this.indicatorAdvancedSettings.volumeProfile;
    const intensity = Math.max(15, Math.min(100, settings.profileGapIntensity)) / 100;
    const fillAlpha = 0.07 + intensity * 0.15;
    const strokeAlpha = 0.16 + intensity * 0.34;

    for (const row of rows) {
      if (!row.profileGap) continue;
      const yHigh = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceHigh)));
      const yLow = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceLow)));
      const y = Math.min(yHigh, yLow);
      const height = Math.max(1, Math.abs(yLow - yHigh));
      const color = this.hexColor(settings.profileGapColor, theme.orangeBright);
      g.rect(leftX, y, Math.max(1, rightX - leftX), height)
        .fill({ color, alpha: fillAlpha })
        .stroke({ width: 0.9, color, alpha: strokeAlpha });
      g.moveTo(leftX, y + height / 2)
        .lineTo(rightX, y + height / 2)
        .stroke({ width: 1.15, color, alpha: Math.min(0.72, strokeAlpha + 0.16) });
    }
  }

  private drawVolumeProfileRow(
    g: Graphics,
    row: VolumeProfileRow,
    maxVolume: number,
    profileWidth: number,
    baseX: number,
    rightPlacement: boolean,
    plotHeight: number,
    settings: VolumeProfileSettings,
    intensity: number
  ) {
    const yHigh = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceHigh)));
    const yLow = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceLow)));
    const y = Math.min(yHigh, yLow);
    const height = Math.max(1, Math.abs(yLow - yHigh) - 0.35);
    const upWidth = (row.buyVolume / maxVolume) * profileWidth;
    const downWidth = (row.sellVolume / maxVolume) * profileWidth;
    const alpha = (row.valueArea ? 0.34 : 0.22) * Math.max(0.42, intensity);
    const upColor = row.valueArea
      ? this.hexColor(settings.valueAreaUpColor, 0x2962ff)
      : this.hexColor(settings.upVolumeColor, 0x5d606b);
    const downColor = row.valueArea
      ? this.hexColor(settings.valueAreaDownColor, 0xfbc02d)
      : this.hexColor(settings.downVolumeColor, 0xd1d4dc);

    if (settings.showVolumeProfile) {
      if (rightPlacement) {
        g.rect(baseX - downWidth, y, downWidth, height).fill({ color: downColor, alpha });
        g.rect(baseX - downWidth - upWidth, y, upWidth, height).fill({ color: upColor, alpha: alpha * 0.92 });
      } else {
        g.rect(baseX, y, upWidth, height).fill({ color: upColor, alpha: alpha * 0.92 });
        g.rect(baseX + upWidth, y, downWidth, height).fill({ color: downColor, alpha });
      }
    }

    if (settings.showSentimentProfile) {
      const deltaWidth = Math.abs(row.delta) / maxVolume * profileWidth * 0.82;
      const deltaColor = row.delta >= 0
        ? this.hexColor(settings.sentimentBullishColor, theme.green)
        : this.hexColor(settings.sentimentBearishColor, theme.redBright);
      const deltaAlpha = Math.min(0.54, 0.12 + Math.abs(row.delta) / Math.max(1, row.totalVolume) * 0.34);
      const deltaY = y + height * 0.22;
      const deltaHeight = Math.max(1, height * 0.56);
      if (rightPlacement) {
        g.rect(baseX - deltaWidth, deltaY, deltaWidth, deltaHeight).fill({ color: deltaColor, alpha: deltaAlpha });
      } else {
        g.rect(baseX, deltaY, deltaWidth, deltaHeight).fill({ color: deltaColor, alpha: deltaAlpha });
      }
    }
  }

  private drawVolumeProfileLevels(
    g: Graphics,
    result: VolumeProfileResult,
    leftX: number,
    baseX: number,
    rightPlacement: boolean,
    settings: VolumeProfileSettings
  ) {
    const levelEnd = rightPlacement ? baseX : Math.max(baseX, leftX);
    const levelStart = rightPlacement ? leftX : baseX;
    const drawLine = (price: number, color: number, width: number, alpha: number, dashed = false) => {
      const y = this.yForPrice(price);
      if (dashed) {
        const start = Math.min(levelStart, levelEnd);
        const end = Math.max(levelStart, levelEnd);
        for (let x = start; x < end; x += 18) {
          g.moveTo(x, y).lineTo(Math.min(end, x + 10), y).stroke({ width, color, alpha });
        }
        return;
      }
      g.moveTo(levelStart, y).lineTo(levelEnd, y).stroke({ width, color, alpha });
    };

    if (settings.showVAH) drawLine(result.valueAreaHigh, this.hexColor(settings.vahColor, 0x2962ff), settings.vahWidth, 0.56);
    if (settings.showVAL) drawLine(result.valueAreaLow, this.hexColor(settings.valColor, 0x2962ff), settings.valWidth, 0.56);
    if (settings.pocMode === "developing") {
      const pocColor = this.hexColor(settings.pocColor, theme.redBright);
      let started = false;
      for (const point of result.developingPoc) {
        if (point.index < this.view.firstIndex || point.index > this.view.lastIndex) continue;
        const x = this.xForIndex(point.index);
        const y = this.yForPrice(point.price);
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
      }
      if (started) g.stroke({ width: settings.pocWidth, color: pocColor, alpha: 0.78 });
    } else if (settings.pocMode === "lastLine") {
      drawLine(result.pocPrice, this.hexColor(settings.pocColor, theme.redBright), settings.pocWidth, 0.78);
    }
  }

  private drawHdlxOverlay(
    g: Graphics,
    result: VolumeProfileResult,
    leftX: number,
    rightX: number,
    profileTop: number,
    profileBottom: number,
    settings: VolumeProfileSettings
  ) {
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const rangeHeight = Math.max(100, profileBottom - profileTop);
    const panelHeight = Math.max(34, Math.min(156, rangeHeight * (settings.hdlxHeight / 100)));
    const requestedTop = profileTop - rangeHeight * (settings.hdlxOffset / 100) - panelHeight;
    const panelTop = Math.max(this.view.topPadding + 8, Math.min(plotHeight - panelHeight - 18, requestedTop));
    const panelBottom = panelTop + panelHeight;
    const panelMid = (panelTop + panelBottom) / 2;
    const panelHalf = Math.max(1, (panelBottom - panelTop) / 2);
    const clamp = Math.max(2, settings.hdlxClamp);
    const [positiveColor, negativeColor] = this.hdlxColors(settings);
    const fillAlpha = Math.max(0.02, Math.min(0.85, (100 - settings.hdlxFillTransparency) / 100));

    if (settings.hdlxShowBackground) {
      g.rect(leftX, panelTop, Math.max(1, rightX - leftX), panelHeight)
        .fill({ color: this.hexColor(settings.hdlxBackgroundColor, 0x000000), alpha: 0.46 })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.08 });
    }

    const yForZ = (value: number) => {
      const z = Math.max(-clamp, Math.min(clamp, value));
      return panelMid - (z / clamp) * panelHalf * 0.92;
    };

    if (settings.hdlxDrawLevels) {
      g.moveTo(leftX, panelMid).lineTo(rightX, panelMid).stroke({ width: 1, color: theme.muted, alpha: 0.30 });
      g.moveTo(leftX, yForZ(settings.hdlxExtreme)).lineTo(rightX, yForZ(settings.hdlxExtreme)).stroke({ width: 1, color: positiveColor, alpha: 0.32 });
      g.moveTo(leftX, yForZ(-settings.hdlxExtreme)).lineTo(rightX, yForZ(-settings.hdlxExtreme)).stroke({ width: 1, color: negativeColor, alpha: 0.32 });
    }

    const barWidth = Math.max(0.6, Math.min(this.timeStep() * 0.78, 5));
    for (const point of result.hdlx) {
      if (point.index < this.view.firstIndex || point.index > this.view.lastIndex) continue;
      const x = this.xForIndex(point.index);
      const y = yForZ(point.value);
      const color = point.value >= 0 ? positiveColor : negativeColor;
      g.rect(x - barWidth / 2, Math.min(y, panelMid), barWidth, Math.max(1, Math.abs(y - panelMid)))
        .fill({ color, alpha: fillAlpha });
    }

    let started = false;
    for (const point of result.hdlx) {
      if (point.index < this.view.firstIndex || point.index > this.view.lastIndex) continue;
      const x = this.xForIndex(point.index);
      const y = yForZ(point.value);
      if (!started) {
        g.moveTo(x, y);
        started = true;
      } else {
        g.lineTo(x, y);
      }
    }
    if (started) {
      g.stroke({
        width: settings.hdlxLineWidth,
        color: settings.hdlxUseCustomLineColor ? this.hexColor(settings.hdlxLineColor, theme.text) : positiveColor,
        alpha: 0.84
      });
    }
  }

  private hdlxColors(settings: VolumeProfileSettings): [number, number] {
    switch (settings.hdlxColorPreset) {
      case "Classic":
        return [theme.redBright, theme.green];
      case "Aqua":
        return [theme.orangeBright, 0x00bfff];
      case "Cosmic":
        return [0x9932cc, 0x49ffce];
      case "Ember":
        return [0x00cccc, theme.orange];
      case "Neon":
        return [0xff00ff, 0xffff00];
      case "Custom":
      default:
        return [
          this.hexColor(settings.hdlxPositiveColor, theme.redBright),
          this.hexColor(settings.hdlxNegativeColor, 0x00ffaa)
        ];
    }
  }

  private drawVolumeProfilePriceLabels(
    result: VolumeProfileResult,
    baseX: number,
    profileWidth: number,
    rightPlacement: boolean,
    settings: VolumeProfileSettings
  ) {
    const size = this.profileTextSize(settings.priceLabelSize);
    const x = rightPlacement ? Math.max(6, baseX - profileWidth - 68) : baseX + profileWidth + 8;
    const labels = [
      { label: "Profile High", price: result.profileHigh, color: theme.silverBright },
      { label: "Value Area High", price: result.valueAreaHigh, color: this.hexColor(settings.vahColor, 0x2962ff) },
      { label: "Point of Control", price: result.pocPrice, color: this.hexColor(settings.pocColor, theme.redBright) },
      { label: "Value Area Low", price: result.valueAreaLow, color: this.hexColor(settings.valColor, 0x2962ff) },
      { label: "Profile Low", price: result.profileLow, color: theme.silverBright }
    ];

    for (const item of labels) {
      this.addProfileText(item.price.toLocaleString(undefined, { maximumFractionDigits: 1 }), x, this.yForPrice(item.price) - size / 2, item.color, size);
    }
  }

  private drawVolumeProfileStats(
    g: Graphics,
    result: VolumeProfileResult,
    settings: VolumeProfileSettings,
    plotWidth: number,
    plotHeight: number
  ) {
    const rows = [
      ["Profile High", result.profileHigh.toLocaleString(undefined, { maximumFractionDigits: 1 })],
      ["Value Area High", result.valueAreaHigh.toLocaleString(undefined, { maximumFractionDigits: 1 })],
      ["Point of Control", result.pocPrice.toLocaleString(undefined, { maximumFractionDigits: 1 })],
      ["Value Area Low", result.valueAreaLow.toLocaleString(undefined, { maximumFractionDigits: 1 })],
      ["Profile Low", result.profileLow.toLocaleString(undefined, { maximumFractionDigits: 1 })],
      ["Total Volume", this.compactVolume(result.totalVolume)],
      ["Avg Volume/Bar", this.compactVolume(result.averageVolume)],
      ["Number of Bars", String(result.endIndex - result.startIndex + 1)],
      ["Data From", settings.rangeMode === "visible" ? "Visible Range" : `Fixed ${settings.fixedRangeLength} bars`]
    ];
    const size = this.profileTextSize(settings.statsSize);
    const width = 182;
    const rowHeight = Math.max(15, size + 6);
    const height = rows.length * rowHeight + 10;
    const x = settings.statsPosition === "Bottom Left" ? 14 : Math.max(12, plotWidth - width - 14);
    const y = settings.statsPosition === "Middle Right"
      ? Math.max(this.view.topPadding + 10, Math.min(plotHeight - height - 10, (plotHeight + this.view.topPadding - height) / 2))
      : settings.statsPosition === "Bottom Left"
        ? Math.max(this.view.topPadding + 10, plotHeight - height - 12)
        : this.view.topPadding + 12;

    g.rect(x, y, width, height)
      .fill({ color: 0x050607, alpha: 0.70 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.10 });

    rows.forEach(([label, value], index) => {
      const rowY = y + 7 + index * rowHeight;
      this.addProfileText(label, x + 8, rowY, theme.muted, size, "500");
      this.addProfileText(value, x + width - 76, rowY, index === 2 ? this.hexColor(settings.pocColor, theme.redBright) : theme.silverBright, size, "600");
    });
  }

  private profileTextSize(size: VolumeProfileSettings["statsSize"] | VolumeProfileSettings["priceLabelSize"]) {
    if (size === "Tiny") return 8;
    if (size === "Normal") return 11;
    return 9;
  }

  private compactVolume(value: number) {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return value.toFixed(2);
  }

  private adaptiveStrategySettings(settings: AdaptiveSwingStrategySettings): StrategySettings {
    return {
      emaFastLength: 20,
      emaSlowLength: 50,
      stopLossPercent: settings.stopLossPercent,
      takeProfitRatio: settings.takeProfitRatio,
      trailingStopPercent: 0,
      breakEvenAtR: 1,
      partialExitAtR: 1.5,
      partialExitPercent: 0,
      atrLength: settings.atrLength,
      regimeEmaLength: settings.regimeEmaLength,
      swingLookback: settings.swingLookback,
      rsiLength: settings.rsiLength,
      rsiOversold: settings.rsiOversold,
      rsiOverbought: settings.rsiOverbought,
      atrStopMultiplier: settings.atrStopMultiplier,
      swingRetestAtr: settings.swingRetestAtr,
      minTrendQuality: settings.minTrendQuality,
      maxChopRatio: settings.maxChopRatio,
      volumeLookback: settings.volumeLookback,
      minVolumeMultiplier: settings.minVolumeMultiplier,
      sessionStartHour: settings.sessionStartHour,
      sessionEndHour: settings.sessionEndHour
    };
  }

  private adaptiveSwingSignalKey(data: Candle[], settings: AdaptiveSwingStrategySettings) {
    const last = data[data.length - 1];
    return [
      this.volumeProfileDataVersion,
      data.length,
      last?.time ?? 0,
      last?.close ?? 0,
      settings.swingLookback,
      settings.atrLength,
      settings.regimeEmaLength,
      settings.rsiLength,
      settings.rsiOversold,
      settings.rsiOverbought,
      settings.atrStopMultiplier,
      settings.swingRetestAtr,
      settings.stopLossPercent,
      settings.takeProfitRatio,
      settings.minTrendQuality,
      settings.maxChopRatio,
      settings.volumeLookback,
      settings.minVolumeMultiplier,
      settings.sessionStartHour ?? "any",
      settings.sessionEndHour ?? "any"
    ].join("|");
  }

  private getAdaptiveSwingSignals(data: Candle[], settings: AdaptiveSwingStrategySettings) {
    const key = this.adaptiveSwingSignalKey(data, settings);
    if (this.adaptiveSwingCache?.key === key) return this.adaptiveSwingCache.signals;
    const signals = createAdaptiveSwingSignals(data, "CHART", this.adaptiveStrategySettings(settings));
    this.adaptiveSwingCache = { key, signals };
    return signals;
  }

  private highestInWindow(data: Candle[], endIndex: number, length: number) {
    const start = Math.max(0, endIndex - length + 1);
    let value = Number.NEGATIVE_INFINITY;
    for (let index = start; index <= endIndex; index++) {
      value = Math.max(value, data[index]?.high ?? value);
    }
    return value;
  }

  private lowestInWindow(data: Candle[], endIndex: number, length: number) {
    const start = Math.max(0, endIndex - length + 1);
    let value = Number.POSITIVE_INFINITY;
    for (let index = start; index <= endIndex; index++) {
      value = Math.min(value, data[index]?.low ?? value);
    }
    return value;
  }

  private adaptiveLabelTextSize(size: AdaptiveSwingStrategySettings["labelSize"]) {
    if (size === "Tiny") return 8;
    if (size === "Normal") return 12;
    return 10;
  }

  private labelOverlaps(rect: { x: number; y: number; width: number; height: number }, labels: { x: number; y: number; width: number; height: number }[]) {
    return labels.some((label) =>
      rect.x < label.x + label.width + 4 &&
      rect.x + rect.width + 4 > label.x &&
      rect.y < label.y + label.height + 3 &&
      rect.y + rect.height + 3 > label.y
    );
  }

  private drawStrategyLabel(
    g: Graphics,
    text: string,
    x: number,
    y: number,
    color: number,
    size: number,
    labels?: { x: number; y: number; width: number; height: number }[]
  ) {
    const width = Math.max(42, text.length * (size * 0.54) + 10);
    const height = size + 7;
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const clampedX = Math.max(4, Math.min(plotWidth - width - 4, x));
    const clampedY = Math.max(this.view.topPadding + 4, Math.min(plotHeight - height - 4, y));
    const rect = { x: clampedX, y: clampedY, width, height };
    if (labels && this.labelOverlaps(rect, labels)) return false;
    labels?.push(rect);
    g.rect(clampedX, clampedY, width, height)
      .fill({ color: 0x050607, alpha: 0.62 })
      .stroke({ width: 1, color, alpha: 0.38 });
    this.addProfileText(text, clampedX + 5, clampedY + 3, color, size, "700");
    return true;
  }

  private buildAdaptiveSwingTradeEvents(data: Candle[], signals: StrategySignal[]) {
    const signalByIndex = new Map<number, StrategySignal[]>();
    const indexByTime = new Map<number, number>();
    data.forEach((candle, index) => indexByTime.set(candle.time, index));
    signals.forEach((signal) => {
      const index = indexByTime.get(signal.timestamp);
      if (index === undefined || !signal.entry || (signal.direction !== "long" && signal.direction !== "short")) return;
      signalByIndex.set(index, [...(signalByIndex.get(index) ?? []), signal]);
    });

    const events: AdaptiveSwingTradeEvent[] = [];
    let open: {
      direction: "long" | "short";
      takeProfit?: number;
      stopLoss?: number;
    } | undefined;

    for (let index = 0; index < data.length; index++) {
      const candle = data[index];
      if (!candle) continue;

      if (open) {
        const stopHit = open.stopLoss !== undefined && (
          open.direction === "long" ? candle.low <= open.stopLoss : candle.high >= open.stopLoss
        );
        const targetHit = open.takeProfit !== undefined && (
          open.direction === "long" ? candle.high >= open.takeProfit : candle.low <= open.takeProfit
        );

        if (stopHit) {
          events.push({ kind: "stopLoss", direction: open.direction, index, price: open.stopLoss ?? candle.close });
          open = undefined;
          continue;
        }

        if (targetHit) {
          events.push({ kind: "takeProfit", direction: open.direction, index, price: open.takeProfit ?? candle.close });
          open = undefined;
          continue;
        }
      }

      if (open) continue;
      const entrySignal = signalByIndex.get(index)?.[0];
      if (!entrySignal || (entrySignal.direction !== "long" && entrySignal.direction !== "short")) continue;

      events.push({
        kind: "entry",
        direction: entrySignal.direction,
        index,
        price: candle.close
      });
      open = {
        direction: entrySignal.direction,
        takeProfit: entrySignal.takeProfit,
        stopLoss: entrySignal.stopLoss
      };
    }

    return events;
  }

  private drawStrategyTriangle(g: Graphics, x: number, y: number, size: number, color: number, up: boolean) {
    if (up) {
      g.poly([x, y - size, x - size * 0.82, y + size * 0.72, x + size * 0.82, y + size * 0.72])
        .fill({ color, alpha: 0.95 })
        .stroke({ width: 1, color: 0x050607, alpha: 0.85 });
      return;
    }

    g.poly([x, y + size, x - size * 0.82, y - size * 0.72, x + size * 0.82, y - size * 0.72])
      .fill({ color, alpha: 0.95 })
      .stroke({ width: 1, color: 0x050607, alpha: 0.85 });
  }

  private drawStrategyDiamond(g: Graphics, x: number, y: number, size: number, color: number) {
    g.poly([x, y - size, x + size, y, x, y + size, x - size, y])
      .fill({ color, alpha: 0.94 })
      .stroke({ width: 1, color: 0x050607, alpha: 0.84 });
  }

  private drawAdaptiveSwingStrategy(g: Graphics, data: Candle[]) {
    const settings = this.indicatorAdvancedSettings.adaptiveSwingStrategy;
    if (!settings || data.length < 10) return;

    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const visual = this.visualFor("adaptiveSwingStrategy", "green");
    const longColor = this.hexColor(settings.longColor, theme.green);
    const shortColor = this.hexColor(settings.shortColor, theme.redBright);
    const targetColor = this.hexColor(settings.takeProfitColor, theme.silverBright);
    const stopColor = this.hexColor(settings.stopLossColor, theme.muted);
    const regimeColor = this.hexColor(settings.regimeEmaColor, theme.redBright);
    const swingColor = this.hexColor(settings.swingLevelColor, theme.orangeBright);
    const labelSize = this.adaptiveLabelTextSize(settings.labelSize);

    if (settings.showRegimeEma) {
      const closes = data.map((candle) => candle.close);
      const regime = this.emaSeries(closes, Math.max(34, Math.round(settings.regimeEmaLength)));
      let started = false;
      for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
        const value = regime[index];
        if (!Number.isFinite(value)) continue;
        const x = this.xForIndex(index);
        const y = this.yForPrice(value);
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
      }
      if (started) g.stroke({ width: 1, color: regimeColor, alpha: visual.alpha * 0.62 });
    }

    if (settings.showSwingLevels) {
      const lookback = Math.max(8, Math.round(settings.swingLookback));
      let highStarted = false;
      let lowStarted = false;
      for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
        if (index < lookback) continue;
        const high = this.highestInWindow(data, index - 1, lookback);
        const x = this.xForIndex(index);
        const highY = this.yForPrice(high);
        if (!highStarted) {
          g.moveTo(x, highY);
          highStarted = true;
        } else {
          g.lineTo(x, highY);
        }
      }
      if (highStarted) g.stroke({ width: 1, color: swingColor, alpha: visual.alpha * 0.22 });

      for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
        if (index < lookback) continue;
        const low = this.lowestInWindow(data, index - 1, lookback);
        const x = this.xForIndex(index);
        const y = this.yForPrice(low);
        if (!lowStarted) {
          g.moveTo(x, y);
          lowStarted = true;
        } else {
          g.lineTo(x, y);
        }
      }
      if (lowStarted) g.stroke({ width: 1, color: swingColor, alpha: visual.alpha * 0.22 });
    }

    if (!settings.showSignals) return;

    const signals = this.getAdaptiveSwingSignals(data, settings);
    if (signals.length === 0) return;
    const marker = Math.max(4, Math.min(12, settings.markerSize));
    const events = this.buildAdaptiveSwingTradeEvents(data, signals).filter((event) =>
      event.index >= this.view.firstIndex && event.index <= this.view.lastIndex
    );
    const dense = this.view.candleWidth < 3.5 || events.length > 22;
    const allowLabels = settings.showSignalLabels && !dense;
    const labelBudget = this.view.candleWidth > 7 ? 18 : this.view.candleWidth > 4.5 ? 10 : 0;
    const placedLabels: { x: number; y: number; width: number; height: number }[] = [];

    events.forEach((event) => {
      if (event.kind === "takeProfit" && !settings.showTakeProfits) return;
      if (event.kind === "stopLoss" && !settings.showStopLosses) return;

      const candle = data[event.index];
      if (!candle) return;

      const x = this.xForIndex(event.index);
      const isLong = event.direction === "long";

      if (event.kind === "entry") {
        const color = isLong ? longColor : shortColor;
        const y = Math.max(
          this.view.topPadding + marker,
          Math.min(plotHeight - marker, isLong ? this.yForPrice(candle.low) + marker * 1.35 : this.yForPrice(candle.high) - marker * 1.35)
        );
        this.drawStrategyTriangle(g, x, y, marker, color, isLong);

        if (allowLabels && placedLabels.length < labelBudget) {
          this.drawStrategyLabel(g, isLong ? "Long Entry" : "Short Entry", x + 7, y - (isLong ? marker * 2.6 : -marker * 1.1), color, labelSize, placedLabels);
        }
        return;
      }

      if (event.kind === "takeProfit") {
        const y = Math.max(
          this.view.topPadding + marker,
          Math.min(plotHeight - marker, isLong ? this.yForPrice(candle.high) - marker * 1.05 : this.yForPrice(candle.low) + marker * 1.05)
        );
        this.drawStrategyDiamond(g, x, y, marker * 0.72, targetColor);
        if (allowLabels && placedLabels.length < labelBudget) {
          this.drawStrategyLabel(g, isLong ? "TP Long" : "TP Short", x + 7, y - labelSize - 6, targetColor, Math.max(7, labelSize - 1), placedLabels);
        }
        return;
      }

      const y = Math.max(
        this.view.topPadding + marker,
        Math.min(plotHeight - marker, isLong ? this.yForPrice(candle.low) + marker * 1.05 : this.yForPrice(candle.high) - marker * 1.05)
      );
      g.circle(x, y, marker * 0.64)
        .fill({ color: stopColor, alpha: visual.alpha * 0.82 })
        .stroke({ width: 1, color: 0x050607, alpha: 0.86 });
      if (allowLabels && placedLabels.length < labelBudget) {
        this.drawStrategyLabel(g, isLong ? "SL Long" : "SL Short", x + 7, y + 3, stopColor, Math.max(7, labelSize - 1), placedLabels);
      }
    });
  }

  private drawInstitutionalVwap(g: Graphics, data: Candle[]) {
    const settings = {
      ...defaultVwapSettings,
      ...this.indicatorAdvancedSettings.vwap
    };
    const result = this.institutionalVwap(data);
    const points = result.points;
    const first = Math.max(0, this.view.firstIndex);
    const last = Math.min(points.length - 1, this.view.lastIndex);
    if (first > last) return;

    const visual = this.visualFor("vwap", "gray");
    const bandAlpha = clampNumber(settings.bandIntensity, 0, 100) / 100;
    const fillAlpha = clampNumber(settings.bandFillIntensity, 0, 100) / 100;
    const lineColor = settings.useCustomLineColor
      ? this.hexColor(settings.lineColor, visual.color)
      : visual.color;
    const bullishColor = this.hexColor(settings.bullishColor, theme.silverBright);
    const bearishColor = this.hexColor(settings.bearishColor, theme.redBright);
    const neutralColor = this.hexColor(settings.neutralColor, theme.muted);

    const isValid = (point: InstitutionalVwapPoint | undefined, field: keyof InstitutionalVwapPoint) =>
      point !== undefined && typeof point[field] === "number" && Number.isFinite(point[field] as number);

    const drawSeries = (
      field: keyof Pick<InstitutionalVwapPoint, "value" | "upper1" | "lower1" | "upper2" | "lower2" | "upper3" | "lower3" | "previousVwap">,
      color: number,
      alpha: number,
      width: number
    ) => {
      let started = false;
      let drew = false;
      let lastValue = Number.NaN;
      for (let index = first; index <= last; index += 1) {
        const point = points[index];
        if (!isValid(point, field)) {
          started = false;
          continue;
        }
        const value = point[field] as number;
        const discontinuity = point.anchor
          || (field === "previousVwap" && Number.isFinite(lastValue) && Math.abs(value - lastValue) > Math.max(1, Math.abs(lastValue)) * 1e-10);
        const x = this.xForIndex(index);
        const y = this.yForPrice(value);
        if (!started || discontinuity) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
          drew = true;
        }
        lastValue = value;
      }
      if (drew) g.stroke({ width, color, alpha });
    };

    if (settings.showBandFill && fillAlpha > 0) {
      const fillColor = this.hexColor(settings.bandFillColor, theme.red);
      let segment: number[] = [];
      const fillSegment = () => {
        if (segment.length < 2) {
          segment = [];
          return;
        }
        const polygon: number[] = [];
        for (const index of segment) {
          polygon.push(this.xForIndex(index), this.yForPrice(points[index].upper1));
        }
        for (let cursor = segment.length - 1; cursor >= 0; cursor -= 1) {
          const index = segment[cursor];
          polygon.push(this.xForIndex(index), this.yForPrice(points[index].lower1));
        }
        if (polygon.length >= 6) g.poly(polygon).fill({ color: fillColor, alpha: fillAlpha });
        segment = [];
      };

      for (let index = first; index <= last; index += 1) {
        const point = points[index];
        if (!isValid(point, "upper1") || !isValid(point, "lower1")) {
          fillSegment();
          continue;
        }
        if (point.anchor && segment.length) fillSegment();
        segment.push(index);
      }
      fillSegment();
    }

    if (settings.showBand3) {
      const color = this.hexColor(settings.band3Color, theme.muted);
      drawSeries("upper3", color, bandAlpha * 0.68, 0.7);
      drawSeries("lower3", color, bandAlpha * 0.68, 0.7);
    }
    if (settings.showBand2) {
      const color = this.hexColor(settings.band2Color, theme.silver);
      drawSeries("upper2", color, bandAlpha * 0.82, 0.85);
      drawSeries("lower2", color, bandAlpha * 0.82, 0.85);
    }
    if (settings.showBand1) {
      const color = this.hexColor(settings.band1Color, theme.silverBright);
      drawSeries("upper1", color, bandAlpha, 1);
      drawSeries("lower1", color, bandAlpha, 1);
    }

    if (settings.showPreviousVwap) {
      drawSeries(
        "previousVwap",
        this.hexColor(settings.previousVwapColor, theme.muted),
        clampNumber(settings.previousVwapIntensity, 0, 100) / 100,
        0.8
      );
    }

    if (settings.dynamicSlopeColor) {
      const directionalColors: Array<{ direction: -1 | 0 | 1; color: number }> = [
        { direction: -1, color: bearishColor },
        { direction: 0, color: neutralColor },
        { direction: 1, color: bullishColor }
      ];
      for (const target of directionalColors) {
        let drew = false;
        for (let index = Math.max(1, first); index <= last; index += 1) {
          const point = points[index];
          const previous = points[index - 1];
          if (
            point.direction !== target.direction
            || point.anchor
            || !isValid(point, "value")
            || !isValid(previous, "value")
          ) {
            continue;
          }
          g.moveTo(this.xForIndex(index - 1), this.yForPrice(previous.value));
          g.lineTo(this.xForIndex(index), this.yForPrice(point.value));
          drew = true;
        }
        if (drew) {
          g.stroke({
            width: clampNumber(settings.lineWidth, 0.5, 6),
            color: target.color,
            alpha: visual.alpha
          });
        }
      }
    } else {
      drawSeries("value", lineColor, visual.alpha, clampNumber(settings.lineWidth, 0.5, 6));
    }

    if (settings.showAnchorMarkers) {
      const markerColor = this.hexColor(settings.anchorMarkerColor, theme.redBright);
      const markerRadius = clampNumber(1.7 + this.view.candleWidth * 0.08, 1.7, 3.2);
      for (const index of result.anchorIndices) {
        if (index < first || index > last) continue;
        const point = points[index];
        if (!isValid(point, "value")) continue;
        g.circle(this.xForIndex(index), this.yForPrice(point.value), markerRadius)
          .fill({ color: markerColor, alpha: 0.92 })
          .stroke({ width: 0.8, color: 0x050506, alpha: 0.9 });
      }
    }
  }

  private drawIndicators() {
    const g = this.indicatorLayer;
    g.clear();
    this.clearProfileTexts();
    this.lastVolumeProfileResult = undefined;
    this.lastVolumeProfileHdlxByIndex.clear();
    const data = this.getDisplayCandles();
    if (data.length === 0) return;

    if (this.visibleIndicators.volumeProfile) {
      this.drawVolumeProfile(g, data);
    }

    const smaAt = (index: number, period: number) => {
      const slice = data.slice(Math.max(0, index - period + 1), index + 1);
      return slice.reduce((a, c) => a + c.close, 0) / Math.max(1, slice.length);
    };

    const standardDeviationAt = (index: number, period: number, mean: number) => {
      const slice = data.slice(Math.max(0, index - period + 1), index + 1);
      const variance = slice.reduce((sum, c) => sum + (c.close - mean) ** 2, 0) / Math.max(1, slice.length);
      return Math.sqrt(variance);
    };

    const smaLine = (period: number, color: number, alpha: number, width = 1) => {
      let started = false;
      for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
        const avg = smaAt(i, period);
        const x = this.xForIndex(i);
        const y = this.yForPrice(avg);
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
      }
      g.stroke({ width, color, alpha });
    };

    const emaLine = (period: number, color: number, alpha: number, width = 1) => {
      const smoothing = 2 / (period + 1);
      let ema = data[0]?.close ?? 0;
      let started = false;

      for (let i = 0; i <= this.view.lastIndex; i++) {
        const candle = data[i];
        if (!candle) continue;
        ema = i === 0 ? candle.close : candle.close * smoothing + ema * (1 - smoothing);
        if (i < this.view.firstIndex) continue;

        const x = this.xForIndex(i);
        const y = this.yForPrice(ema);
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
      }
      g.stroke({ width, color, alpha });
    };

    const bollingerBands = (period: number) => {
      const visual = this.visualFor("bollinger", "silver");
      const upper: number[] = [];
      const lower: number[] = [];
      let midStarted = false;
      let upperStarted = false;
      let lowerStarted = false;

      for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
        const mean = smaAt(i, period);
        const deviation = standardDeviationAt(i, period, mean) * 2;
        const x = this.xForIndex(i);
        const upperY = this.yForPrice(mean + deviation);
        const midY = this.yForPrice(mean);
        const lowerY = this.yForPrice(mean - deviation);

        upper.push(x, upperY);
        lower.unshift(lowerY);
        lower.unshift(x);

        if (!midStarted) {
          g.moveTo(x, midY);
          midStarted = true;
        } else {
          g.lineTo(x, midY);
        }
      }

      if (midStarted) g.stroke({ width: 1, color: visual.color, alpha: visual.alpha * 0.30 });

      for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
        const mean = smaAt(i, period);
        const deviation = standardDeviationAt(i, period, mean) * 2;
        const x = this.xForIndex(i);
        const upperY = this.yForPrice(mean + deviation);
        const lowerY = this.yForPrice(mean - deviation);

        if (!upperStarted) {
          g.moveTo(x, upperY);
          upperStarted = true;
        } else {
          g.lineTo(x, upperY);
        }
      }
      if (upperStarted) g.stroke({ width: 1, color: visual.color, alpha: visual.alpha * 0.48 });

      for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
        const mean = smaAt(i, period);
        const deviation = standardDeviationAt(i, period, mean) * 2;
        const x = this.xForIndex(i);
        const lowerY = this.yForPrice(mean - deviation);

        if (!lowerStarted) {
          g.moveTo(x, lowerY);
          lowerStarted = true;
        } else {
          g.lineTo(x, lowerY);
        }
      }
      if (lowerStarted) g.stroke({ width: 1, color: visual.color, alpha: visual.alpha * 0.48 });

      if (upper.length > 4 && lower.length > 4) {
        g.poly([...upper, ...lower]).fill({ color: visual.color, alpha: visual.alpha * 0.035 });
      }
    };

    if (this.visibleIndicators.bollinger) bollingerBands(this.indicatorPeriods.bollinger);
    if (this.visibleIndicators.vwap) this.drawInstitutionalVwap(g, data);
    if (this.visibleIndicators.sma20) {
      const visual = this.visualFor("sma20", "silver");
      smaLine(this.indicatorPeriods.sma20, visual.color, visual.alpha * 0.72, 1);
    }
    if (this.visibleIndicators.sma50) {
      const visual = this.visualFor("sma50", "gray");
      smaLine(this.indicatorPeriods.sma50, visual.color, visual.alpha * 0.62, 1);
    }
    if (this.visibleIndicators.ema20) {
      const visual = this.visualFor("ema20", "white");
      emaLine(this.indicatorPeriods.ema20, visual.color, visual.alpha * 0.64, 1);
    }
    if (this.visibleIndicators.ema50) {
      const visual = this.visualFor("ema50", "silver");
      emaLine(this.indicatorPeriods.ema50, visual.color, visual.alpha * 0.54, 1);
    }
    if (this.visibleIndicators.ema200) {
      const visual = this.visualFor("ema200", "red");
      emaLine(this.indicatorPeriods.ema200, visual.color, visual.alpha * 0.92, 1);
    }
    if (this.visibleIndicators.adaptiveSwingStrategy) {
      this.drawAdaptiveSwingStrategy(g, data);
    }
    
    // Draw custom compiled script indicator plots
    for (const plot of this.customPlots) {
      const color = this.hexColor(plot.color, 0x00ffcc);
      let started = false;
      for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
        const val = plot.values[i];
        if (val === null || val === undefined || Number.isNaN(val)) {
          started = false;
          continue;
        }
        const x = this.xForIndex(i);
        const y = this.yForPrice(val);
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
      }
      g.stroke({ width: plot.width || 1, color, alpha: 0.95 });
    }

    this.drawOscillatorPanes(data);
  }

  public setCustomPlots(plots: CompiledPlot[]) {
    this.customPlots = plots;
    this.draw();
  }

  private drawVolume() {
    const g = this.volumeLayer;
    g.clear();
    if (!this.visibleIndicators.volume) return;
    const data = this.getDisplayCandles();
    if (data.length === 0) return;

    const oscHeight = this.getOscillatorPaneHeight();
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const priceAreaBottom = plotHeight - oscHeight;

    const visible = data.slice(this.view.firstIndex, this.view.lastIndex + 1);
    const maxVol = Math.max(...visible.map(c => c.volume), 1);
    const visual = this.visualFor("volume", "red");

    for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
      const c = data[i];
      if (!c) continue;
      const barWidth = Math.max(0.35, Math.min(this.view.candleWidth, this.timeStep()));
      const x = this.xForIndex(i) - barWidth / 2;
      const h = (c.volume / maxVol) * 96;
      const color = c.close >= c.open ? theme.silver : visual.color;
      const alpha = (this.view.candleWidth < 0.8 ? 0.16 : c.close >= c.open ? 0.20 : 0.32) * Math.max(0.35, visual.alpha);
      g.rect(x, priceAreaBottom - h, barWidth, h).fill({ color, alpha });
    }
  }

  private volumeProfileCandleOverride(candle: Candle, index: number, data: Candle[]) {
    if (!this.visibleIndicators.volumeProfile) return undefined;
    const settings = this.indicatorAdvancedSettings.volumeProfile;
    if (settings.hdlxEnableBarColoring && this.lastVolumeProfileResult?.hdlx.length) {
      const hdlxValue = this.lastVolumeProfileHdlxByIndex.get(index);
      if (hdlxValue !== undefined && Number.isFinite(hdlxValue)) {
        const [positiveColor, negativeColor] = this.hdlxColors(settings);
        return {
          color: hdlxValue >= 0 ? positiveColor : negativeColor,
          wick: hdlxValue >= 0 ? positiveColor : negativeColor,
          alpha: Math.min(1, 0.48 + Math.abs(hdlxValue) / Math.max(2, settings.hdlxClamp) * 0.42)
        };
      }
    }

    if (!settings.volumeWeightedBarColoring) return undefined;
    const length = Math.max(1, Math.min(500, Math.round(settings.volumeMaLength)));
    const from = Math.max(0, index - length + 1);
    const sample = data.slice(from, index + 1);
    const averageVolume = sample.reduce((sum, item) => sum + item.volume, 0) / Math.max(1, sample.length);
    const bullish = candle.close >= candle.open;

    if (candle.volume > averageVolume * settings.upperThreshold) {
      return {
        color: bullish ? this.hexColor(settings.strongBarUpColor, 0x006400) : this.hexColor(settings.strongBarDownColor, 0x910000),
        wick: bullish ? this.hexColor(settings.strongBarUpColor, 0x4bbf62) : this.hexColor(settings.strongBarDownColor, theme.redBright),
        alpha: 0.98
      };
    }

    if (candle.volume < averageVolume * settings.lowerThreshold) {
      return {
        color: bullish ? this.hexColor(settings.weakBarUpColor, 0x7fffd4) : this.hexColor(settings.weakBarDownColor, theme.orange),
        wick: bullish ? this.hexColor(settings.weakBarUpColor, 0x7fffd4) : this.hexColor(settings.weakBarDownColor, theme.orangeBright),
        alpha: 0.88
      };
    }

    return undefined;
  }

  private drawCandles() {
    const g = this.candleLayer;
    g.clear();
    const data = this.getDisplayCandles();
    if (data.length === 0) return;
    if (this.chartType === "line") {
      this.drawLineSeries(g, data);
      return;
    }

    for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
      const c = data[i];
      if (!c) continue;
      const x = this.xForIndex(i);
      if (this.chartType === "renko") {
        this.drawRenkoBrick(g, c, x);
      } else if (this.chartType === "hollow") {
        this.drawHollowCandle(g, c, data[i - 1], x);
      } else if (this.chartType === "volumeFootprint") {
        this.drawClassicCandle(g, c, x, { color: c.close >= c.open ? theme.silver : theme.red, alpha: 0.28 });
      } else {
        this.drawClassicCandle(g, c, x, this.volumeProfileCandleOverride(c, i, data));
      }
    }
  }

  private drawClassicCandle(
    g: Graphics,
    c: Candle,
    x: number,
    override?: { color: number; wick?: number; alpha?: number }
  ) {
    const openY = this.yForPrice(c.open);
    const closeY = this.yForPrice(c.close);
    const highY = this.yForPrice(c.high);
    const lowY = this.yForPrice(c.low);
    const bullish = c.close >= c.open;
    const referencePalette = this.visibleIndicators.liquidationHeatmap
      && this.liquidationFieldSettings.candlePalette === "REFERENCE_CYAN_MAGENTA";
    const defaultColor = bullish ? (referencePalette ? 0x31d5cf : theme.silver) : (referencePalette ? 0xec145d : theme.red);
    const defaultWick = bullish ? (referencePalette ? 0x7ff7ee : theme.silverBright) : (referencePalette ? 0xff4b83 : theme.redBright);
    const color = override?.color ?? defaultColor;
    const wick = override?.wick ?? defaultWick;
    const bclifActive = this.visibleIndicators.liquidationHeatmap;
    const alpha = bclifActive ? Math.max(0.95, override?.alpha ?? 0.98) : override?.alpha ?? 0.98;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(openY - closeY));

    if (this.view.candleWidth < 1.2) {
      const wickWidth = Math.max(0.35, Math.min(0.85, this.view.candleWidth * 1.7));
      const bodyWidth = Math.max(0.55, Math.min(1.15, this.view.candleWidth * 2.6));
      g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: wickWidth, color: wick, alpha: bclifActive ? 0.95 : 0.54 });
      g.moveTo(x, openY).lineTo(x, closeY).stroke({ width: bodyWidth, color, alpha: bclifActive ? alpha : alpha * 0.92 });
      return;
    }

    const bodyWidth = Math.max(1, this.view.candleWidth);
    const contrast = this.visibleIndicators.liquidationHeatmap ? this.liquidationFieldSettings.candleContrast : "STANDARD";
    const haloWidth = contrast === "MAXIMUM" ? 3.15 : contrast === "HIGH" ? 2.35 : 0;
    if (haloWidth > 0) {
      g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: haloWidth, color: 0x000000, alpha: 0.78 });
      g.rect(x - bodyWidth / 2 - 0.7, bodyTop - 0.7, bodyWidth + 1.4, bodyHeight + 1.4)
        .fill({ color: 0x000000, alpha: contrast === "MAXIMUM" ? 0.88 : 0.68 });
    }
    g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: contrast === "MAXIMUM" ? 1.45 : 1.15, color: wick, alpha: 0.98 });
    g.rect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight).fill({ color, alpha });
  }

  private drawHollowCandle(g: Graphics, c: Candle, previous: Candle | undefined, x: number) {
    const openY = this.yForPrice(c.open);
    const closeY = this.yForPrice(c.close);
    const highY = this.yForPrice(c.high);
    const lowY = this.yForPrice(c.low);
    const hollow = c.close >= c.open;
    const rising = previous ? c.close >= previous.close : hollow;
    const color = rising ? theme.silverBright : theme.redBright;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(openY - closeY));
    if (this.view.candleWidth < 1.2) {
      this.drawClassicCandle(g, c, x);
      return;
    }

    const bodyWidth = Math.max(1, this.view.candleWidth);

    g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: 1.15, color, alpha: 0.92 });
    if (hollow) {
      g.rect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight)
        .fill({ color, alpha: 0.055 })
        .stroke({ width: 1.05, color, alpha: 0.96 });
    } else {
      g.rect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight).fill({ color, alpha: 0.95 });
    }
  }

  private drawRenkoBrick(g: Graphics, c: Candle, x: number) {
    const openY = this.yForPrice(c.open);
    const closeY = this.yForPrice(c.close);
    const bullish = c.close >= c.open;
    const color = bullish ? theme.silverBright : theme.red;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(3, Math.abs(openY - closeY));
    const bodyWidth = Math.max(1, this.view.candleWidth + this.view.gap * 0.7);

    g.rect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight)
      .fill({ color, alpha: bullish ? 0.78 : 0.92 })
      .stroke({ width: 0.8, color: bullish ? theme.text : theme.redBright, alpha: 0.42 });
  }

  private drawLineSeries(g: Graphics, data: Candle[]) {
    let started = false;
    let lastPoint: { x: number; y: number } | undefined;

    for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
      const c = data[i];
      if (!c) continue;
      const x = this.xForIndex(i);
      const y = this.yForPrice(c.close);
      if (!started) {
        g.moveTo(x, y);
        started = true;
      } else {
        g.lineTo(x, y);
      }
      lastPoint = { x, y };
    }

    if (started) {
      g.stroke({ width: 2, color: theme.silverBright, alpha: 0.9 });
    }
    if (lastPoint) {
      g.circle(lastPoint.x, lastPoint.y, 3.2).fill({ color: theme.redBright, alpha: 0.96 });
    }
  }

  private activePriceAlerts() {
    return this.alertDefinitions.filter((alert) =>
      alert.enabled &&
      !alert.fired &&
      alert.indicator === "price" &&
      Number.isFinite(alert.targetPrice)
    );
  }

  private drawDashedHorizontalLine(g: Graphics, y: number, x1: number, x2: number, color: number, alpha: number, dash = 8, gap = 6) {
    for (let x = x1; x < x2; x += dash + gap) {
      g.moveTo(x, y).lineTo(Math.min(x + dash, x2), y).stroke({ width: 1, color, alpha });
    }
  }

  private drawPriceAlertLines() {
    const g = this.alertLayer;
    g.clear();
    this.clearAlertTexts();

    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    for (const alert of this.activePriceAlerts()) {
      const price = alert.targetPrice!;
      const y = this.yForPrice(price);
      if (y < this.view.topPadding || y > plotHeight) continue;

      const color = this.hexColor(alert.color ?? "#ffffff", theme.text);
      this.drawDashedHorizontalLine(g, y, 0, plotWidth, color, 0.72, 9, 6);
      g.circle(plotWidth - 76, y, 3.1).fill({ color, alpha: 0.98 });
      g.rect(plotWidth + 4, y - 12, 72, 24)
        .fill({ color: 0xf2f4f8, alpha: 0.96 })
        .stroke({ width: 1, color, alpha: 0.82 });
      g.moveTo(plotWidth - 6, y).lineTo(plotWidth + 4, y).stroke({ width: 1, color, alpha: 0.82 });
      this.addAlertText(price.toLocaleString(undefined, { maximumFractionDigits: 1 }), plotWidth + 9, y - 7, 0x07090b);
    }
  }

  private hitPriceAlertLine(x: number, y: number) {
    if (!this.isInsidePlot(x, y) && !this.isInsidePriceAxis(x, y)) return undefined;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    if (y < this.view.topPadding || y > plotHeight) return undefined;

    return this.activePriceAlerts()
      .map((alert) => ({ alert, distance: Math.abs(this.yForPrice(alert.targetPrice!) - y) }))
      .filter((entry) => entry.distance <= 7)
      .sort((a, b) => a.distance - b.distance)[0]?.alert;
  }

  private clearAlertTexts() {
    for (const text of this.alertTexts) {
      text.destroy();
    }
    this.alertTexts = [];
  }

  private addAlertText(text: string, x: number, y: number, color: number) {
    const item = new Text({
      text,
      style: {
        fontFamily: "IBM Plex Mono",
        fontSize: 10,
        fill: color,
        fontWeight: "900"
      }
    });
    item.x = x;
    item.y = y;
    this.alertTexts.push(item);
    this.alertTextLayer.addChild(item);
    return item;
  }

  private drawDrawings() {
    const g = this.drawingGraphics;
    g.clear();
    this.clearDrawingTexts();
    if (!this.drawingsVisible) return;

    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const drawings = this.draftDrawing ? [...this.drawings, this.draftDrawing] : this.drawings;

    const pointXY = (point: DrawingPoint) => ({
      x: this.xForIndex(point.index),
      y: this.yForPrice(point.price)
    });

    for (const drawing of drawings) {
      const [a, b] = drawing.points;
      if (!a) continue;
      const start = pointXY(a);
      const end = b ? pointXY(b) : start;
      const draft = drawing === this.draftDrawing;
      const alpha = draft ? 0.58 : 0.88;

      if (drawing.tool === "horizontalLine") {
        g.moveTo(0, start.y).lineTo(plotWidth, start.y).stroke({ width: 1.2, color: theme.redBright, alpha });
        g.circle(start.x, start.y, 3).fill({ color: theme.redBright, alpha: 0.88 });
        continue;
      }

      if (drawing.tool === "verticalLine") {
        g.moveTo(start.x, this.view.topPadding).lineTo(start.x, plotHeight).stroke({ width: 1.1, color: theme.silverBright, alpha: alpha * 0.72 });
        g.circle(start.x, start.y, 3).fill({ color: theme.redBright, alpha: 0.88 });
        continue;
      }

      if (drawing.tool === "trendLine") {
        g.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ width: 1.35, color: theme.redBright, alpha });
        g.circle(start.x, start.y, 3).fill({ color: theme.redBright, alpha: 0.9 });
        g.circle(end.x, end.y, 3).fill({ color: theme.redBright, alpha: 0.9 });
        continue;
      }

      if (drawing.tool === "rectangle") {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        g.rect(x, y, w, h)
          .fill({ color: theme.red, alpha: draft ? 0.025 : 0.045 })
          .stroke({ width: 1.1, color: theme.redBright, alpha });
        continue;
      }

      if (drawing.tool === "fibonacci") {
        const x1 = Math.min(start.x, end.x);
        const x2 = Math.max(start.x, end.x, x1 + 80);
        const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const colors = [theme.silverBright, theme.redBright, theme.silver, theme.orange, theme.redBright, theme.silver, theme.silverBright];
        g.rect(x1, Math.min(start.y, end.y), x2 - x1, Math.abs(end.y - start.y))
          .fill({ color: theme.red, alpha: draft ? 0.016 : 0.026 });

        levels.forEach((level, index) => {
          const y = start.y + (end.y - start.y) * level;
          const color = colors[index] ?? theme.silverBright;
          g.moveTo(x1, y).lineTo(x2, y).stroke({ width: level === 0.5 ? 1.2 : 1, color, alpha: level === 0.618 ? alpha : alpha * 0.74 });
          this.addDrawingText(`${(level * 100).toFixed(level === 0 ? 0 : 1)}%`, x2 + 6, y - 7, color, 10);
        });
        continue;
      }

      if (drawing.tool === "brush") {
        if (drawing.points.length < 2) continue;
        drawing.points.forEach((point, index) => {
          const p = pointXY(point);
          if (index === 0) g.moveTo(p.x, p.y);
          else g.lineTo(p.x, p.y);
        });
        g.stroke({ width: 1.7, color: theme.redBright, alpha: alpha * 0.86 });
        continue;
      }

      if (drawing.tool === "text") {
        this.addDrawingText(drawing.text ?? "Text", start.x + 5, start.y - 18, theme.silverBright, 12);
        g.circle(start.x, start.y, 2.6).fill({ color: theme.redBright, alpha: 0.88 });
        continue;
      }

      if (drawing.tool === "measure") {
        g.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ width: 1.2, color: theme.silverBright, alpha });
        g.circle(start.x, start.y, 3).fill({ color: theme.silverBright, alpha: 0.88 });
        g.circle(end.x, end.y, 3).fill({ color: theme.redBright, alpha: 0.88 });
        const candles = Math.abs(Math.round((b?.index ?? a.index) - a.index));
        const change = b ? ((b.price - a.price) / a.price) * 100 : 0;
        this.addDrawingText(`${candles} bars  ${change.toFixed(2)}%`, (start.x + end.x) / 2 + 8, (start.y + end.y) / 2 - 18, theme.silverBright, 11);
      }
    }
  }

  private clearDrawingTexts() {
    for (const text of this.drawingTexts) {
      text.destroy();
    }
    this.drawingTexts = [];
  }

  private addDrawingText(text: string, x: number, y: number, color: number, size: number) {
    const item = new Text({
      text,
      style: {
        fontFamily: "IBM Plex Mono",
        fontSize: size,
        fill: color,
        fontWeight: "700"
      }
    });
    item.x = x;
    item.y = y;
    this.drawingTexts.push(item);
    this.drawingLayer.addChild(item);
  }

  private clearProfileTexts() {
    for (const text of this.profileTexts) {
      text.destroy();
    }
    this.profileTexts = [];
  }

  private clearHeatmapTexts() {
    for (const text of this.heatmapTexts) {
      text.destroy();
    }
    this.heatmapTexts = [];
  }

  private addHeatmapText(text: string, x: number, y: number, color: number, size = 9) {
    const item = new Text({
      text,
      style: {
        fontFamily: "IBM Plex Mono",
        fontSize: size,
        fill: color,
        fontWeight: "700"
      }
    });
    item.x = x;
    item.y = y;
    this.heatmapTexts.push(item);
    this.heatmapLayer.addChild(item);
    return item;
  }

  private addProfileText(
    text: string,
    x: number,
    y: number,
    color: number,
    size = 10,
    weight: "400" | "500" | "600" | "700" = "600"
  ) {
    const item = new Text({
      text,
      style: {
        fontFamily: "IBM Plex Mono",
        fontSize: size,
        fill: color,
        fontWeight: weight
      }
    });
    item.x = x;
    item.y = y;
    this.profileTexts.push(item);
    this.indicatorLayer.addChild(item);
    return item;
  }

  private clearTexts() {
    for (const t of [...this.priceTexts, ...this.timeTexts, ...this.labelTexts, ...this.hudTexts]) {
      t.removeFromParent();
      t.visible = false;
      this.axisTextPool.push(t);
    }
    this.priceTexts = [];
    this.timeTexts = [];
    this.labelTexts = [];
    this.hudTexts = [];
  }

  private addText(
    target: Text[],
    text: string,
    x: number,
    y: number,
    size = 11,
    color = theme.muted,
    weight: "400" | "500" | "600" | "700" = "400",
    family = "IBM Plex Mono"
  ) {
    const t = this.axisTextPool.pop() ?? new Text({ text: "", style: {} });
    t.text = text;
    t.style.fontFamily = family;
    t.style.fontSize = size;
    t.style.fill = color;
    t.style.fontWeight = weight;
    t.x = x;
    t.y = y;
    t.visible = true;
    target.push(t);
    this.axisLayer.addChild(t);
    return t;
  }

  private clearCrosshairTexts() {
    for (const t of this.crosshairTexts) {
      t.destroy();
    }
    this.crosshairTexts = [];
  }

  private addCrosshairText(text: string, x: number, y: number) {
    const t = new Text({
      text,
      style: {
        fontFamily: "IBM Plex Mono",
        fontSize: 10,
        fill: 0xffffff,
        fontWeight: "600"
      }
    });
    t.x = x;
    t.y = y;
    this.crosshairTexts.push(t);
    this.crosshairLayer.addChild(t);
    return t;
  }

  private getAlignedTimeTicks(data: Candle[]) {
    const ticks: { index: number; x: number; time: number; label: string }[] = [];
    const firstCandle = data[this.view.firstIndex];
    const lastCandle = data[this.view.lastIndex];
    if (!firstCandle || !lastCandle) return ticks;

    const timeRange = lastCandle.time - firstCandle.time;
    if (timeRange <= 0) return ticks;

    const targetStep = timeRange / 7;
    const standardSteps = [
      60, 300, 900, 1800, 3600, 7200, 14400, 43200, 86400, 172800, 432000, 604800, 1209600, 2592000, 7776000, 31536000
    ];
    let step = standardSteps[0];
    let minDiff = Math.abs(targetStep - step);
    for (const s of standardSteps) {
      const diff = Math.abs(targetStep - s);
      if (diff < minDiff) {
        minDiff = diff;
        step = s;
      }
    }

    const firstAlignedTime = Math.ceil(firstCandle.time / step) * step;
    const lastAlignedTime = Math.floor(lastCandle.time / step) * step;

    const findClosestIndex = (time: number) => {
      let low = this.view.firstIndex;
      let high = this.view.lastIndex;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (data[mid].time < time) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return low;
    };

    let lastDrawnIdx = -1;
    let lastDateStr = "";
    let lastMonthStr = "";
    let lastYearStr = "";

    for (let t = firstAlignedTime; t <= lastAlignedTime; t += step) {
      const idx = findClosestIndex(t);
      if (idx === lastDrawnIdx || idx < this.view.firstIndex || idx > this.view.lastIndex) continue;
      const c = data[idx];
      if (!c) continue;

      const x = this.xForIndex(idx);
      const d = new Date(c.time * 1000);

      const year = d.getFullYear();
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const month = monthNames[d.getMonth()];
      const day = d.getDate();
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");

      let label = "";
      const isNewYear = lastYearStr === "" || String(year) !== lastYearStr;
      const isNewMonth = lastMonthStr === "" || month !== lastMonthStr || isNewYear;
      const isNewDay = lastDateStr === "" || String(day) !== lastDateStr || isNewMonth;

      const intervalSec = data.length >= 2 ? Math.max(1, data[data.length - 1].time - data[data.length - 2].time) : 3600;

      if (intervalSec >= 86400) {
        if (isNewYear) {
          label = `${year}`;
        } else if (isNewMonth) {
          label = `${month}`;
        } else {
          label = `${month} ${day}`;
        }
      } else {
        if (isNewMonth) {
          label = `${month} ${day}`;
        } else if (isNewDay) {
          label = `${month} ${day}`;
        } else {
          label = `${hours}:${minutes}`;
        }
      }

      lastDateStr = String(day);
      lastMonthStr = month;
      lastYearStr = String(year);
      lastDrawnIdx = idx;

      ticks.push({ index: idx, x, time: c.time, label });
    }

    return ticks;
  }

  private timeLabelForX(x: number) {
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const step = this.timeStep();
    const barsFromRight = Math.round((plotWidth - this.view.candleWidth / 2 - 12 - x) / step);
    const index = Math.max(this.view.firstIndex, Math.min(this.view.lastIndex, this.view.lastIndex - barsFromRight));
    const candle = this.getDisplayCandles()[index];
    if (!candle) return "";

    const d = new Date(candle.time * 1000);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = String(d.getDate()).padStart(2, "0");
    const year = String(d.getFullYear()).slice(2);
    const hour = String(d.getHours()).padStart(2, "0");
    const minute = String(d.getMinutes()).padStart(2, "0");
    return `${day} ${months[d.getMonth()]} '${year} ${hour}:${minute}`;
  }

  private drawAxes() {
    const g = this.axisLayer;
    g.clear();
    this.clearTexts();

    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const pricePlotBottom = this.view.topPadding + this.getPricePlotHeight();

    // right price scale
    this.addText(this.hudTexts, "USDT", plotWidth + 18, 11, 11, theme.text, "600", "Inter");

    for (let i = 0; i <= 10; i++) {
      const y = this.view.topPadding + ((plotHeight - this.view.topPadding) / 10) * i;
      if (y > pricePlotBottom) continue;
      const price = this.priceForY(y);
      this.addText(
        this.priceTexts,
        price.toLocaleString(undefined, { maximumFractionDigits: 1 }),
        plotWidth + 10,
        y - 7,
        11,
        theme.muted
      );
    }

    // current price label
    const data = this.getDisplayCandles();
    const last = data[data.length - 1];
    if (last) {
      const y = this.yForPrice(last.close);
      const isRising = last.close >= last.open;
      const defaultColor = isRising ? 0x00ff66 : 0xff101b;
      const lineColor = this.priceLineColor ? this.hexColor(this.priceLineColor, defaultColor) : defaultColor;
      const lineAlpha = (this.priceLineIntensity ?? 75) / 100;
      const dashLength = 3;
      const gapLength = 3;
      let currentX = 0;
      while (currentX < plotWidth) {
        g.moveTo(currentX, y).lineTo(Math.min(currentX + dashLength, plotWidth), y);
        currentX += dashLength + gapLength;
      }
      g.stroke({ width: 0.85, color: lineColor, alpha: lineAlpha });

      // Calculate timeframe in seconds from candles
      let timeframeSeconds = 60;
      if (data.length >= 2) {
        timeframeSeconds = data[data.length - 1].time - data[data.length - 2].time;
      }
      
      const timeRemainingSeconds = Math.max(0, (last.time + timeframeSeconds) - Math.floor(Date.now() / 1000));
      
      const formatCountdown = (secs: number) => {
        if (secs <= 0) return "00:00";
        if (secs >= 86400) {
          const d = Math.floor(secs / 86400);
          const h = Math.floor((secs % 86400) / 3600);
          return `${d}d ${h}h`;
        }
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        if (h > 0) {
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
        return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      };

      const priceText = last.close.toLocaleString(undefined, { maximumFractionDigits: 1 });
      const timerText = formatCountdown(timeRemainingSeconds);

      // Neon-glowing TradingView style box
      g.rect(plotWidth + 4, y - 18, 74, 36)
        .fill({ color: 0x07090b, alpha: 0.96 })
        .stroke({ width: 1.5, color: lineColor, alpha: 0.95 });

      this.addText(
        this.priceTexts,
        priceText,
        plotWidth + 9,
        y - 14,
        10,
        0xffffff,
        "700"
      );

      this.addText(
        this.priceTexts,
        timerText,
        plotWidth + 9,
        y + 2,
        9,
        0xff0055,
        "600"
      );
    }

    // bottom time axis
    const ticks = this.getAlignedTimeTicks(data);
    for (const tick of ticks) {
      this.addText(this.timeTexts, tick.label, tick.x - 18, plotHeight + 9, 11, theme.muted);
      g.moveTo(tick.x, plotHeight).lineTo(tick.x, plotHeight + 5).stroke({ width: 1, color: 0xffffff, alpha: 0.10 });
    }

    // chart range buttons, lower left
    const ranges = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"];
    let rx = 14;
    for (const r of ranges) {
      this.addText(this.hudTexts, r, rx, this.view.height - 24, 11, r === "1D" ? theme.text : theme.muted, "600", "Inter");
      rx += r === "YTD" ? 34 : 28;
    }

    // bottom right status
    this.addText(this.hudTexts, "11:22:18 (UTC+2)   %   log   auto", plotWidth - 225, this.view.height - 24, 11, theme.muted);

    // small chart TV-like block replaced by BT
    g.roundRect(12, plotHeight - 34, 28, 22, 4).fill({ color: 0xffffff, alpha: 0.08 }).stroke({ color: 0xffffff, alpha: 0.10, width: 1 });
    this.addText(this.hudTexts, "BT", 18, plotHeight - 30, 11, theme.text, "700", "Inter");
  }

  private drawCrosshair() {
    const g = this.crosshairLayer;
    g.clear();
    this.clearCrosshairTexts();

    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    if (!this.pointer.active || this.pointer.x < 0 || this.pointer.x > plotWidth || this.pointer.y < this.view.topPadding || this.pointer.y > plotHeight) return;

    g.moveTo(this.pointer.x, this.view.topPadding)
      .lineTo(this.pointer.x, plotHeight)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.22 });
    g.moveTo(0, this.pointer.y)
      .lineTo(plotWidth, this.pointer.y)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.22 });

    g.circle(this.pointer.x, this.pointer.y, 3).fill({ color: theme.redBright, alpha: 0.9 });

    const ddaBounds = this.ddaProPaneBounds();
    const insideDdaPane = Boolean(ddaBounds && this.pointer.y >= ddaBounds.top && this.pointer.y <= ddaBounds.bottom);
    g.rect(plotWidth + 4, this.pointer.y - 11, 64, 22).fill({ color: theme.red, alpha: 0.95 });
    if (insideDdaPane && ddaBounds) {
      const domain = ddaProDomain(this.ddaProBaseDepth(), this.ddaProCamera);
      const ratio = Math.max(0, Math.min(1, (this.pointer.y - (ddaBounds.top + 18)) / Math.max(1, ddaBounds.height - 34)));
      const value = domain.max - ratio * domain.range;
      this.addCrosshairText(value.toFixed(Math.abs(value) >= 10 ? 1 : 2) + "%", plotWidth + 8, this.pointer.y - 7);
    } else {
      const price = this.priceForY(this.pointer.y);
      this.addCrosshairText(price.toLocaleString(undefined, { maximumFractionDigits: 1 }), plotWidth + 8, this.pointer.y - 7);
    }

    const timeLabel = this.timeLabelForX(this.pointer.x);
    g.rect(this.pointer.x - 54, plotHeight + 3, 108, 22).fill({ color: theme.red, alpha: 0.95 });
    this.addCrosshairText(timeLabel, this.pointer.x - 49, plotHeight + 7);

    const ddaSnapshot = this.visibleIndicators.ddaProOscillator ? this.ddaProSnapshot : null;
    const ddaPane = this.oscillatorStackLayout().panes.find((pane) => pane.key === "ddaProOscillator");
    if (ddaSnapshot && ddaPane) {
      const paneBottom = plotHeight - 16 - ddaPane.bottomOffset;
      const paneTop = paneBottom - ddaPane.height;
      if (this.pointer.y >= paneTop && this.pointer.y <= paneBottom) {
        const chartIndex = this.indexForX(this.pointer.x);
        const sourceIndex = chartIndex - Math.max(0, this.getDisplayCandles().length - ddaSnapshot.inputSize);
        if (sourceIndex >= 0 && sourceIndex < ddaSnapshot.inputSize) {
          const depth = ddaSnapshot.series.depth[sourceIndex] ?? 0;
          const nearestTail = depth >= Math.abs(ddaSnapshot.series.p99[sourceIndex] ?? 0) ? "P99"
            : depth >= Math.abs(ddaSnapshot.series.p95[sourceIndex] ?? 0) ? "P95"
              : depth >= Math.abs(ddaSnapshot.series.p90[sourceIndex] ?? 0) ? "P90"
                : depth >= Math.abs(ddaSnapshot.series.p75[sourceIndex] ?? 0) ? "P75" : "P50";
          const tooltipX = Math.max(8, Math.min(plotWidth - 248, this.pointer.x + 14));
          const tooltipY = Math.max(paneTop + 5, Math.min(paneBottom - 76, this.pointer.y + 12));
          g.roundRect(tooltipX, tooltipY, 240, 72, 4)
            .fill({ color: 0x030305, alpha: 0.96 })
            .stroke({ width: 1, color: theme.red, alpha: 0.72 });
          this.addCrosshairText("DDA " + (ddaSnapshot.series.riskState[sourceIndex] ?? "INSUFFICIENT") + " · RISK " + (ddaSnapshot.series.riskScore[sourceIndex] ?? 0).toFixed(1), tooltipX + 8, tooltipY + 6);
          this.addCrosshairText("DRAWDOWN " + (ddaSnapshot.series.rawDrawdown[sourceIndex] ?? 0).toFixed(2) + "% · DEPTH RANK " + (ddaSnapshot.series.percentileRank[sourceIndex] ?? 0).toFixed(1) + "%", tooltipX + 8, tooltipY + 21);
          this.addCrosshairText("DURATION " + (ddaSnapshot.series.duration[sourceIndex] ?? 0).toFixed(0) + " · VELOCITY " + (ddaSnapshot.series.velocity[sourceIndex] ?? 0).toFixed(3), tooltipX + 8, tooltipY + 36);
          this.addCrosshairText("VADD " + (ddaSnapshot.series.vadd[sourceIndex] ?? 0).toFixed(3) + " · NEAREST TAIL " + nearestTail, tooltipX + 8, tooltipY + 51);
        }
      }
    }
  }
}
