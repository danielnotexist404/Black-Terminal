import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Text
} from "pixi.js";
import { CandleBuffer } from "./data/CandleBuffer";
import { CausalRenkoStream, type CausalRenkoSnapshot } from "./causalRenko";
import { resolveFixedLookbackWindow, VolumeProfileModel, VolumeProfileResult, VolumeProfileRow } from "./profile/VolumeProfileModel";
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
import {
  customOscillatorScriptId,
  customOscillatorScriptIds,
  resolveOscillatorStack
} from "./indicators/oscillatorLayout";
import type { IndicatorAlertDefinition } from "../automation/alerts";
import type { CompiledMarker, CompiledPlot } from "../components/ScriptCompiler";
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
import { ddaProSigmaUnit, nearestDDAProTailLabel } from "../modules/dda-pro/rendering/diagnostics";
import { bclifTimestampMsToChartSeconds } from "../modules/liquidation-field/rendering/timeProjection";
import type { DDAProSnapshot } from "../modules/dda-pro/core/types";
import type { AcvdSnapshot } from "../modules/acvd/core/types";
import { calculateCvdOscillator } from "../modules/cvd-oscillator/core/engine";
import { migrateCvdOscillatorSettings } from "../modules/cvd-oscillator/core/settings";
import type { CvdOscillatorSnapshot } from "../modules/cvd-oscillator/core/types";
import { calculateMarketSentiment } from "../modules/market-sentiment/core/engine";
import { migrateMarketSentimentSettings } from "../modules/market-sentiment/core/settings";
import type { MarketSentimentSnapshot } from "../modules/market-sentiment/core/types";
import { acvdContiguousFiniteSegments } from "../modules/acvd/rendering/segments";
import { HorizonWaveEngine } from "../modules/horizon-candles/core/HorizonWaveEngine";
import { BLACK_HORIZON_DEFAULTS, migrateHorizonCandleMode } from "../modules/horizon-candles/core/settings";
import type { HorizonCandleMode } from "../modules/horizon-candles/core/types";
import { HorizonCandleRenderer } from "../modules/horizon-candles/rendering/HorizonCandleRenderer";
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
  aggregateCandleRenderBuckets,
  chartRenderIndices,
  chartRenderStride,
  visibleCandleDomain
} from "./renderLod";
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
  kind: "poc" | "vah" | "val" | "lvn" | "supportZone" | "resistanceZone";
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
  private causalRenko = new CausalRenkoStream();
  private causalRenkoRevision = 0;
  private displayedCandles: Candle[] = [];
  private displayedCandlesCache?: { dataVersion: number; renkoRevision: number; chartType: ChartDisplayType; candles: Candle[] };
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
  private horizonWaveEngine = new HorizonWaveEngine();
  private horizonRenderer = new HorizonCandleRenderer(this.horizonWaveEngine);
  private horizonSettings: HorizonCandleMode = structuredClone(BLACK_HORIZON_DEFAULTS);
  private auctionProfileSnapshots: AuctionProfileSnapshot[] = [];
  private ddaProSnapshot: DDAProSnapshot | null = null;
  private acvdSnapshot: AcvdSnapshot | null = null;
  private auctionProfileSettings: AuctionProfileSettings = structuredClone(AUCTION_PROFILE_DEFAULT_SETTINGS);
  private constrainedTouchRenderer = false;
  private volumeProfileModel = new VolumeProfileModel();
  private lastVolumeProfileResult?: VolumeProfileResult;
  private lastVolumeProfileHdlxByIndex = new Map<number, number>();
  private volumeProfileCache?: { key: string; result: VolumeProfileResult | null };
  private adaptiveSwingCache?: { key: string; signals: StrategySignal[] };
  private volumeProfileDataVersion = 0;
  private heatmapVisibleUntilIndex?: number;
  private chartType: ChartDisplayType = "candlesticks";
  private snapToLatest = true;
  private onPriceChange?: (price: number) => void;
  private onCandleChange?: (candle: Candle) => void;
  private onScriptFeedChange?: (revision: number) => void;
  private onPriceTransformChange?: (transform: ChartPriceTransformSnapshot) => void;
  private onLiquidationRendererMetrics?: (metrics: BclifRendererMetrics) => void;
  private onNeedMoreHistory?: (oldestCandle: Candle) => void;
  private onFps?: (fps: number) => void;
  private onAlertEditRequest?: (alertId: string) => void;
  private activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDistance: number | null = null;
  private lastCountdownTime = 0;
  private countdownText?: Text;
  private renderIndexCache?: { key: string; indices: number[] };
  private emaRenderCache = new Map<string, number[]>();
  private emaRenderCacheVersion = -1;
  private volumeAverageCache?: { dataVersion: number; length: number; values: number[] };
  private customPlots: CompiledPlot[] = [];
  private customMarkers: CompiledMarker[] = [];
  private alertDefinitions: IndicatorAlertDefinition[] = [];
  private visibleIndicators: VisibleIndicators = {
    qalc: false,
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
    acvdOscillator: false,
    cvdOscillator: false,
    marketSentimentOscillator: false,
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
    ddaProOscillator: 500,
    acvdOscillator: 1000,
    cvdOscillator: 5000,
    marketSentimentOscillator: 5000
  };
  private indicatorVisualSettings: IndicatorVisualSettings = {
    qalc: { color: "white", intensity: 92 },
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
    acvdOscillator: { color: "white", intensity: 92 },
    cvdOscillator: { color: "white", intensity: 100 },
    marketSentimentOscillator: { color: "white", intensity: 94 },
    volume: { color: "red", intensity: 62 }
  };
  private indicatorAdvancedSettings: IndicatorAdvancedSettings = defaultIndicatorAdvancedSettings;
  private institutionalVwapCache?: { key: string; result: InstitutionalVwapResult };
  private cvdOscillatorCache?: { key: string; snapshot: CvdOscillatorSnapshot };
  private marketSentimentCache?: { key: string; snapshot: MarketSentimentSnapshot };

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
  private acvdDragging = false;
  private acvdCamera: DDAProCamera = resetDDAProCamera();
  private acvdDragStartCamera: DDAProCamera = resetDDAProCamera();
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
  private renderRaf?: number;
  private visibilityRecoveryRaf?: number;
  private visibilitySettleRaf?: number;
  private webglContextLost = false;
  private mockTimer?: number;
  private countdownTimer?: number;
  private frameCount = 0;
  private lastFpsTime = performance.now();
  private lastTickerFrameAt = performance.now();
  private readonly resourceOwner = `pixi-chart:${Math.random().toString(36).slice(2)}`;
  private releaseVisibilityListener?: () => void;
  private releaseResizeObserver?: () => void;

  constructor(options: ChartEngineOptions) {
    this.host = options.host;
    this.candles = new CandleBuffer(options.candles);
    this.causalRenko.resetFromCandles(options.candles);
    if (options.chartType) this.chartType = options.chartType;
    if (options.horizonSettings) this.horizonSettings = migrateHorizonCandleMode(options.horizonSettings);
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
    if (options.acvdSnapshot !== undefined) this.acvdSnapshot = options.acvdSnapshot;
    if (options.auctionProfileSettings) {
      this.auctionProfileSettings = migrateAuctionProfileSettings(options.auctionProfileSettings);
    }
    this.onPriceChange = options.onPriceChange;
    this.onCandleChange = options.onCandleChange;
    this.onScriptFeedChange = options.onScriptFeedChange;
    this.onPriceTransformChange = options.onPriceTransformChange;
    this.onLiquidationRendererMetrics = options.onLiquidationRendererMetrics;
    this.onNeedMoreHistory = options.onNeedMoreHistory;
    this.onFps = options.onFps;
    this.alertDefinitions = options.alertDefinitions ?? [];
    this.customPlots = (options.customPlots ?? []) as CompiledPlot[];
    this.customMarkers = (options.customMarkers ?? []) as CompiledMarker[];
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
      powerPreference: "high-performance",
      autoStart: false
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
      this.horizonRenderer.container,
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
      const acvdPaneBounds = this.acvdPaneBounds();
      const insideDdaAxis = Boolean(
        ddaPaneBounds
        && e.global.y >= ddaPaneBounds.top
        && e.global.y <= ddaPaneBounds.bottom
        && e.global.x >= ddaPaneBounds.plotWidth - 24
      );
      const insideAcvdAxis = Boolean(acvdPaneBounds && e.global.y >= acvdPaneBounds.top && e.global.y <= acvdPaneBounds.bottom && e.global.x >= acvdPaneBounds.plotWidth - 24);
      this.setPriceScaleHover(!insideDdaAxis && !insideAcvdAxis && this.isInsidePriceAxis(e.global.x, e.global.y));
      this.host.classList.toggle("dda-pro-scale-hover", insideDdaAxis || insideAcvdAxis);
      this.activePointers.set(e.pointerId, { x: e.global.x, y: e.global.y });

      if (this.activePointers.size === 2) {
        this.ddaProDragging = false;
        this.acvdDragging = false;
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
      } else if (this.acvdDragging) {
        const dx = e.global.x - this.dragStartX;
        const dy = e.global.y - this.dragStartY;
        this.view.scrollX = this.clampHorizontalScroll(this.dragStartScroll + dx);
        const pane = this.acvdPaneBounds();
        if (pane) this.acvdCamera = this.panAcvdCamera(this.acvdDragStartCamera, dy, pane.height);
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
        this.queueRender();
      }
    });

    this.app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
      this.activePointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
      if (this.activePointers.size === 2) {
        this.ddaProDragging = false;
        this.acvdDragging = false;
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
      const acvdPaneBounds = this.acvdPaneBounds();
      if (
        acvdPaneBounds
        && e.global.x >= 0
        && e.global.x <= this.view.width
        && e.global.y >= acvdPaneBounds.top
        && e.global.y <= acvdPaneBounds.bottom
      ) {
        this.acvdDragging = true;
        this.dragStartX = e.global.x;
        this.dragStartY = e.global.y;
        this.dragStartScroll = this.view.scrollX;
        this.acvdDragStartCamera = { ...this.acvdCamera };
        this.host.classList.add("dda-pro-dragging");
        return;
      }
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
      this.queueRender();
    });

    this.host.addEventListener("wheel", this.onWheel, { passive: false });
    this.host.addEventListener("dblclick", this.onDoubleClick);
    this.host.addEventListener("contextmenu", this.onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this.queueResize());
    this.releaseResizeObserver = blackCoreResourceTracker.acquire("observer", `${this.resourceOwner}:resize`);
    this.resizeObserver.observe(this.host);
    window.addEventListener("black-terminal-layout-resize", this.queueResize);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("pageshow", this.handlePageShow);
    window.addEventListener("focus", this.handleWindowFocus);
    this.releaseVisibilityListener = blackCoreResourceTracker.acquire("listener", `${this.resourceOwner}:visibility`);

    this.countdownTimer = window.setInterval(() => this.updateCountdown(), 1000);
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
        this.causalRenko.ingestSourceCandleClose(last);
        this.candles.push(next, this.maxRetainedCandles());
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

      this.causalRenko.observeSourceCandle(emittedCandle);
      this.causalRenkoRevision += 1;

      this.volumeProfileDataVersion += 1;
      this.setHeatmapSource(this.candles.all());
      this.onPriceChange?.(close);
      this.onCandleChange?.(emittedCandle);
      this.queueDraw();

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
    this.causalRenko.resetFromCandles(candles);
    this.causalRenkoRevision += 1;
    this.volumeProfileDataVersion += 1;
    this.setHeatmapSource(options.heatmapSource ?? candles, options.heatmapUntilIndex);
    if (!options.preserveView) {
      this.view.scrollX = 0;
      this.manualPriceRange = undefined;
    }
    const last = this.candles.last();
    this.onPriceChange?.(last?.close ?? 0);
    if (last) this.onCandleChange?.(last);
    this.onScriptFeedChange?.(this.causalRenkoRevision);
    this.draw();
  }

  prependCandles(candles: Candle[]) {
    const added = this.candles.prepend(candles, this.maxRetainedCandles());
    if (added > 0) {
      this.volumeProfileDataVersion += 1;
      this.setHeatmapSource(this.candles.all());
      this.draw();
    }
  }

  upsertCandle(candle: Candle) {
    const last = this.candles.last();
    if (last && candle.time < last.time) return;
    let completedRenkoBrick = false;
    if (last?.time === candle.time) {
      this.candles.updateLast(candle);
    } else {
      if (last) completedRenkoBrick = this.causalRenko.ingestSourceCandleClose(last);
      this.candles.push(candle, this.maxRetainedCandles());
    }
    this.causalRenko.observeSourceCandle(candle);
    this.causalRenkoRevision += 1;

    this.volumeProfileDataVersion += 1;
    this.setHeatmapSource(this.candles.all());
    this.onPriceChange?.(candle.close);
    this.onCandleChange?.(candle);
    if (completedRenkoBrick) this.onScriptFeedChange?.(this.causalRenkoRevision);
    this.queueDraw();
  }

  /** Ingests only canonical public trades; ticker heartbeats must never enter this stream. */
  ingestCausalRenkoTrade(price: number, quantity: number, time: number, identity?: string) {
    const normalizedTime = time > 1_000_000_000_000 ? time / 1000 : time;
    const completedRenkoBrick = this.causalRenko.ingestTrade(price, quantity, normalizedTime, identity);
    this.causalRenkoRevision += 1;
    this.displayedCandlesCache = undefined;
    if (completedRenkoBrick) this.onScriptFeedChange?.(this.causalRenkoRevision);
    if (this.chartType === "renko") this.queueDraw();
    return completedRenkoBrick;
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

  getScreenXForTimestamp(timeSeconds: number) {
    return this.xForTimestamp(timeSeconds);
  }

  getVisibleTimeRange() {
    const candles = this.getDisplayCandles();
    const first = candles[this.view.firstIndex];
    const last = candles[this.view.lastIndex];
    return first && last ? { from: first.time, to: last.time } : undefined;
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
            })),
          ...result.rows
            .filter((row) => row.supplyDemand !== null)
            .map((row) => ({
              kind: row.supplyDemand === "demand" ? "supportZone" as const : "resistanceZone" as const,
              label: row.supplyDemand === "demand" ? "Support / Demand" : "Resistance / Supply",
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
    this.queueDraw();
  }

  setAcvdState(snapshot: AcvdSnapshot | null) {
    this.acvdSnapshot = snapshot;
    this.cvdOscillatorCache = undefined;
    this.marketSentimentCache = undefined;
    this.queueDraw();
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

  getCustomScriptCandles() {
    if (this.chartType !== "renko") return this.getSourceCandles();
    return this.causalRenko.snapshot().candles.map((candle) => ({ ...candle }));
  }

  getCustomScriptFeed(): "SOURCE_OHLCV" | "CAUSAL_RENKO" {
    return this.chartType === "renko" ? "CAUSAL_RENKO" : "SOURCE_OHLCV";
  }

  getCausalRenkoStatus(): CausalRenkoSnapshot {
    return this.causalRenko.snapshot();
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
    if (chartType !== "horizon") this.horizonRenderer.clear();
    this.displayedCandles = [];
    this.manualPriceRange = undefined;
    this.draw();
  }

  setHorizonSettings(settings: HorizonCandleMode) {
    this.horizonSettings = migrateHorizonCandleMode(settings);
    this.horizonWaveEngine.clear();
    if (this.chartType === "horizon") this.draw();
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
      this.causalRenko.observeSourceCandle(next);
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
      const completedRenkoBrick = this.causalRenko.ingestSourceCandleClose(last);
      this.candles.push(next, this.maxRetainedCandles());
      this.causalRenko.observeSourceCandle(next);
      this.causalRenkoRevision += 1;
      if (completedRenkoBrick) this.onScriptFeedChange?.(this.causalRenkoRevision);
      this.onCandleChange?.(next);
    }

    this.volumeProfileDataVersion += 1;
    this.setHeatmapSource(this.candles.all());
    this.onPriceChange?.(price);
    this.queueDraw();
  }

  private setHeatmapSource(candles: Candle[], visibleUntilIndex = candles.length - 1) {
    this.heatmapVisibleUntilIndex = Math.max(0, Math.min(Math.max(0, candles.length - 1), visibleUntilIndex));
  }

  private onBclifContextLost = (event: Event) => {
    event.preventDefault();
    this.webglContextLost = true;
    this.host.classList.add("chart-surface-recovering");
    this.cancelScheduledFrames();
    this.liquidationFieldRenderer.handleContextLost();
  };

  private onBclifContextRestored = () => {
    this.webglContextLost = false;
    this.liquidationFieldRenderer.handleContextRestored();
    this.liquidationFieldRenderer.setState(this.liquidationFieldSnapshot, this.liquidationFieldSettings);
    this.recoverVisibleSurface();
  };

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.mockTimer) window.clearInterval(this.mockTimer);
    if (this.countdownTimer) window.clearInterval(this.countdownTimer);
    this.host.removeEventListener("wheel", this.onWheel);
    this.host.removeEventListener("dblclick", this.onDoubleClick);
    this.host.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("black-terminal-layout-resize", this.queueResize);
    this.app.canvas.removeEventListener("webglcontextlost", this.onBclifContextLost);
    this.app.canvas.removeEventListener("webglcontextrestored", this.onBclifContextRestored);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("pageshow", this.handlePageShow);
    window.removeEventListener("focus", this.handleWindowFocus);
    this.cancelScheduledFrames();
    this.host.classList.remove("price-scale-dragging", "price-scale-hover", "drawing-eraser", "chart-surface-recovering");
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
      this.cvdFootprintRenderer.container,
      this.horizonRenderer.container
    );
    this.kioseffRenderer.dispose();
    this.liquidationFieldRenderer.dispose();
    this.auctionProfileRenderer.dispose();
    this.cvdFootprintRenderer.dispose();
    this.horizonRenderer.dispose();
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
    this.acvdDragging = false;
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
    const plotWidth = this.view.width - this.view.rightAxisWidth - this.rightAnalysisGutter();
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
    const acvdPaneBounds = this.acvdPaneBounds();
    if (acvdPaneBounds && y >= acvdPaneBounds.top && y <= acvdPaneBounds.bottom && x >= acvdPaneBounds.plotWidth - 24) {
      e.preventDefault();
      this.acvdCamera = resetDDAProCamera();
      this.queueDraw();
      return;
    }
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

  private queueRender() {
    if (this.destroyed || this.renderRaf || document.visibilityState !== "visible") return;
    this.renderRaf = window.requestAnimationFrame(() => {
      this.renderRaf = undefined;
      if (this.destroyed) return;
      const startedAt = performance.now();
      this.app.render();
      blackCorePerformanceMonitor.recordMetric("chart.gpu_frame_ms", performance.now() - startedAt, "ms", { surface: "pixi-chart" });
      this.tickFps();
    });
  }

  private handleVisibilityChange = () => {
    if (this.destroyed) return;
    if (document.visibilityState === "visible") {
      this.recoverVisibleSurface();
    } else {
      this.host.classList.add("chart-surface-recovering");
      this.cancelScheduledFrames();
    }
  };

  private handlePageShow = () => {
    this.recoverVisibleSurface();
  };

  private handleWindowFocus = () => {
    if (document.visibilityState === "visible") this.recoverVisibleSurface();
  };

  private cancelScheduledFrames() {
    if (this.resizeRaf) window.cancelAnimationFrame(this.resizeRaf);
    if (this.drawRaf) window.cancelAnimationFrame(this.drawRaf);
    if (this.renderRaf) window.cancelAnimationFrame(this.renderRaf);
    if (this.visibilityRecoveryRaf) window.cancelAnimationFrame(this.visibilityRecoveryRaf);
    if (this.visibilitySettleRaf) window.cancelAnimationFrame(this.visibilitySettleRaf);
    this.resizeRaf = undefined;
    this.drawRaf = undefined;
    this.renderRaf = undefined;
    this.visibilityRecoveryRaf = undefined;
    this.visibilitySettleRaf = undefined;
  }

  private recoverVisibleSurface() {
    if (this.destroyed || this.webglContextLost || document.visibilityState !== "visible") return;
    this.host.classList.add("chart-surface-recovering");
    this.cancelScheduledFrames();
    this.visibilityRecoveryRaf = window.requestAnimationFrame(() => {
      this.visibilityRecoveryRaf = undefined;
      if (this.destroyed || this.webglContextLost || document.visibilityState !== "visible") return;
      this.resize();
      this.visibilitySettleRaf = window.requestAnimationFrame(() => {
        this.visibilitySettleRaf = undefined;
        if (this.destroyed || this.webglContextLost || document.visibilityState !== "visible") return;
        this.draw();
        this.app.render();
        this.host.classList.remove("chart-surface-recovering");
      });
    });
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();

    const bounds = this.host.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    const ddaPaneBounds = this.ddaProPaneBounds();
    const acvdPaneBounds = this.acvdPaneBounds();
    if (acvdPaneBounds && y >= acvdPaneBounds.top && y <= acvdPaneBounds.bottom && x >= acvdPaneBounds.plotWidth - 24) {
      const anchorRatio = (y - acvdPaneBounds.top) / Math.max(1, acvdPaneBounds.height);
      this.acvdCamera = this.zoomAcvdCamera(this.acvdCamera, e.deltaY, anchorRatio);
      this.queueDraw();
      return;
    }
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
  }

  private updateCountdown() {
    if (this.destroyed || document.visibilityState !== "visible") return;
    const epochSec = Math.floor(Date.now() / 1000);
    if (epochSec === this.lastCountdownTime) return;
    this.lastCountdownTime = epochSec;
    if (!this.countdownText) return;
    const next = this.currentCandleCountdown();
    if (this.countdownText.text === next) return;
    this.countdownText.text = next;
    this.queueRender();
  }

  private currentCandleCountdown() {
    const data = this.getDisplayCandles();
    const last = data.at(-1);
    if (!last) return "00:00";
    const timeframeSeconds = data.length >= 2
      ? Math.max(1, data[data.length - 1]!.time - data[data.length - 2]!.time)
      : 60;
    const remaining = Math.max(0, last.time + timeframeSeconds - Math.floor(Date.now() / 1000));
    if (remaining <= 0) return "00:00";
    if (remaining >= 86400) {
      const days = Math.floor(remaining / 86400);
      const hours = Math.floor((remaining % 86400) / 3600);
      return `${days}d ${hours}h`;
    }
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  private getDisplayCandles() {
    return this.displayedCandles.length ? this.displayedCandles : this.candles.all();
  }

  private refreshDisplayCandles() {
    const cached = this.displayedCandlesCache;
    if (cached?.dataVersion === this.volumeProfileDataVersion && cached.renkoRevision === this.causalRenkoRevision && cached.chartType === this.chartType) {
      this.displayedCandles = cached.candles;
      return;
    }
    const candles = this.createDisplayCandles(this.candles.all());
    this.displayedCandlesCache = {
      dataVersion: this.volumeProfileDataVersion,
      renkoRevision: this.causalRenkoRevision,
      chartType: this.chartType,
      candles
    };
    this.displayedCandles = candles;
  }

  private timeStep() {
    if (this.chartType === "horizon") {
      const plotWidth = Math.max(1, this.view.width - this.view.rightAxisWidth - this.rightAnalysisGutter());
      const expectedSamples = Math.max(1, Math.round(this.horizonSettings.displayHorizonMs / 1000));
      const fitStep = plotWidth / expectedSamples;
      const zoom = Math.max(0.04, (this.view.candleWidth + this.view.gap) / (4.8 + 2.2));
      return Math.max(0.0125, fitStep * zoom * this.horizonSettings.horizonScale);
    }
    return Math.max(0.05, this.view.candleWidth + this.view.gap);
  }

  private maxRetainedCandles() {
    return this.chartType === "horizon" ? 100_000 : 20_000;
  }

  private renderStride(minimumPixelSpacing = 1) {
    return chartRenderStride(this.timeStep(), minimumPixelSpacing);
  }

  private renderIndices(minimumPixelSpacing = 1) {
    const stride = this.renderStride(minimumPixelSpacing);
    const key = `${this.view.firstIndex}:${this.view.lastIndex}:${stride}`;
    if (this.renderIndexCache?.key === key) return this.renderIndexCache.indices;
    const indices = chartRenderIndices(this.view.firstIndex, this.view.lastIndex, stride);
    this.renderIndexCache = { key, indices };
    return indices;
  }

  private cachedEmaSeries(data: Candle[], period: number) {
    if (this.emaRenderCacheVersion !== this.volumeProfileDataVersion) {
      this.emaRenderCache.clear();
      this.emaRenderCacheVersion = this.volumeProfileDataVersion;
    }
    const safePeriod = Math.max(1, Math.round(period));
    const key = `${this.chartType}:${data.length}:${safePeriod}`;
    const cached = this.emaRenderCache.get(key);
    if (cached) return cached;
    const result = this.emaSeries(data.map((candle) => candle.close), safePeriod);
    this.emaRenderCache.set(key, result);
    return result;
  }

  private cachedVolumeAverages(data: Candle[], length: number) {
    const safeLength = Math.max(1, Math.min(500, Math.round(length)));
    if (this.volumeAverageCache?.dataVersion === this.volumeProfileDataVersion && this.volumeAverageCache.length === safeLength) {
      return this.volumeAverageCache.values;
    }
    const values = new Array<number>(data.length);
    let sum = 0;
    for (let index = 0; index < data.length; index++) {
      sum += data[index]?.volume ?? 0;
      const dropIndex = index - safeLength;
      if (dropIndex >= 0) sum -= data[dropIndex]?.volume ?? 0;
      values[index] = sum / Math.min(index + 1, safeLength);
    }
    this.volumeAverageCache = { dataVersion: this.volumeProfileDataVersion, length: safeLength, values };
    return values;
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

  private toRenko(_source: Candle[]) {
    return this.causalRenko.snapshot().candles;
  }

  private calculateView() {
    this.refreshDisplayCandles();
    const data = this.getDisplayCandles();
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const step = this.timeStep();
    const visibleCount = Math.ceil(plotWidth / step) + 80;
    this.view.scrollX = this.clampHorizontalScroll(this.view.scrollX);
    const lastIndex = Math.max(0, Math.min(data.length - 1, data.length - 1 - Math.floor(this.view.scrollX / step)));
    const firstIndex = Math.max(0, lastIndex - visibleCount);

    const domain = visibleCandleDomain(data, firstIndex, lastIndex);
    let min = domain.minimum;
    let max = domain.maximum;
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
        data[firstIndex]?.time ?? null,
        data[lastIndex]?.time ?? null
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
    const plotWidth = this.view.width - this.view.rightAxisWidth - this.rightAnalysisGutter();
    const step = this.timeStep();
    const barsFromLatest = this.getDisplayCandles().length - 1 - index;
    return plotWidth - barsFromLatest * step - this.view.candleWidth / 2 - 12 + this.view.scrollX;
  }

  private volumeProfileRightGutter() {
    const settings = this.indicatorAdvancedSettings.volumeProfile;
    if (!this.visibleIndicators.volumeProfile || settings.rangeMode !== "fixed" || settings.placement !== "right" || !settings.showVolumeProfile) return 0;
    const plotWidth = Math.max(0, this.view.width - this.view.rightAxisWidth);
    return Math.min(plotWidth * 0.36, Math.max(110, 70 + Math.max(0, settings.widthPercent) * 3.2));
  }

  private cvdOscillatorRightGutter() {
    const settings = migrateCvdOscillatorSettings(this.indicatorAdvancedSettings.cvdOscillator);
    if (!this.visibleIndicators.cvdOscillator || !settings.showStatusPanel || !settings.reserveRightGutter) return 0;
    const plotWidth = Math.max(0, this.view.width - this.view.rightAxisWidth);
    return Math.min(plotWidth * 0.3, Math.max(170, settings.statusPanelWidth + 20));
  }

  private rightAnalysisGutter() {
    return Math.max(this.volumeProfileRightGutter(), this.cvdOscillatorRightGutter());
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
        customPaneHeights: {
          ...defaultOscillatorPaneSettings.customPaneHeights,
          ...(configuredPane?.customPaneHeights ?? {})
        },
        order: configuredPane?.order ?? defaultOscillatorPaneSettings.order
      },
      {
        ...defaultWaveTrendOscillatorSettings,
        ...(this.indicatorAdvancedSettings.waveTrendOscillator ?? {})
      },
      this.view.height,
      this.view.bottomAxisHeight,
      this.view.topPadding,
      customOscillatorScriptIds(this.customPlots)
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

  private acvdPaneBounds() {
    if (!this.visibleIndicators.acvdOscillator) return undefined;
    const pane = this.oscillatorStackLayout().panes.find((candidate) => candidate.key === "acvdOscillator");
    if (!pane) return undefined;
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const bottom = plotHeight - 16 - pane.bottomOffset;
    const top = bottom - pane.height;
    return { top, bottom, height: pane.height, plotWidth };
  }

  private acvdDomain(camera = this.acvdCamera) {
    const zoom = clampNumber(Number.isFinite(camera.zoom) ? camera.zoom : 1, 0.2, 40);
    const range = 200 / zoom;
    const center = clampNumber(Number.isFinite(camera.pan) ? camera.pan : 0, -800, 800);
    return { min: center - range / 2, max: center + range / 2, range };
  }

  private acvdValueToY(value: number, paneTop: number, paneBottom: number) {
    const domain = this.acvdDomain();
    const top = paneTop + 18;
    const bottom = Math.max(top + 1, paneBottom - 16);
    const ratio = (domain.max - value) / Math.max(1e-9, domain.range);
    return top + clampNumber(ratio, 0, 1) * (bottom - top);
  }

  private panAcvdCamera(camera: DDAProCamera, pixelDeltaY: number, paneHeight: number): DDAProCamera {
    const domain = this.acvdDomain(camera);
    return { zoom: camera.zoom, pan: clampNumber(camera.pan + pixelDeltaY / Math.max(1, paneHeight - 34) * domain.range, -800, 800) };
  }

  private zoomAcvdCamera(camera: DDAProCamera, deltaY: number, anchorRatio: number): DDAProCamera {
    const before = this.acvdDomain(camera);
    const ratio = clampNumber(anchorRatio, 0, 1);
    const anchor = before.max - ratio * before.range;
    const zoom = clampNumber(camera.zoom * Math.exp(-deltaY * 0.0028), 0.2, 40);
    const nextRange = 200 / zoom;
    const center = anchor + ratio * nextRange - nextRange / 2;
    return { zoom, pan: clampNumber(center, -800, 800) };
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
    let visibleMaximum = 0;
    for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
      const sourceIndex = index - offset;
      const value = sourceIndex >= 0 ? snapshot.series.rawDrawdown[sourceIndex] : undefined;
      if (Number.isFinite(value)) visibleMaximum = Math.max(visibleMaximum, Math.abs(value!));
    }
    return Math.max(
      1,
      Math.min(
        100,
        Math.max(
          visibleMaximum,
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
    const startedAt = performance.now();
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
    blackCorePerformanceMonitor.recordMetric("chart.geometry_build_ms", performance.now() - startedAt, "ms", { surface: "pixi-chart" });
    blackCorePerformanceMonitor.recordMetric("chart.visible_bars", this.view.lastIndex - this.view.firstIndex + 1, "count", { surface: "pixi-chart" });
    blackCorePerformanceMonitor.recordMetric("chart.render_stride", this.renderStride(1), "count", { surface: "pixi-chart" });
    this.queueRender();
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
        for (const i of this.renderIndices(1)) {
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
      for (const i of this.renderIndices(1)) {
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
    const aligned = <T,>(values: readonly T[] | undefined, index: number): T | undefined => {
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
      this.addProfileText("BC-RDA · CALCULATING RISK DISTRIBUTION", 12, paneTop + 12, theme.muted, 9, "700");
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
      for (const index of this.renderIndices(1.15)) {
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
      const lowerForward: number[] = [];
      for (const index of this.renderIndices(1.15)) {
        const upperValue = aligned(upperValues, index);
        const lowerValue = aligned(lowerValues, index);
        if (!Number.isFinite(upperValue) || !Number.isFinite(lowerValue)) continue;
        upper.push(this.xForIndex(index), yForDrawdown(upperValue!));
        lowerForward.push(this.xForIndex(index), yForDrawdown(lowerValue!));
      }
      if (upper.length >= 4 && lowerForward.length >= 4) {
        const polygon = [...upper];
        for (let cursor = lowerForward.length - 2; cursor >= 0; cursor -= 2) {
          polygon.push(lowerForward[cursor]!, lowerForward[cursor + 1]!);
        }
        g.poly(polygon).fill({ color, alpha });
      }
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
        const upper = snapshot.series.sigmaUpper[index];
        return ddaProSigmaUnit(mean, lower!, upper!, encodedMultiplier, settings.downsideOnlySigma);
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
    if (settings.showFlowPressure) {
      const bullish = this.hexColor(settings.flowBullishColor, theme.silverBright);
      const bearish = this.hexColor(settings.flowBearishColor, theme.redBright);
      const neutral = this.hexColor(settings.flowNeutralColor, theme.muted);
      const baseAlpha = Math.max(0, Math.min(1, settings.flowLineIntensity / 100));
      const indices = this.renderIndices(1.15);
      const denseFlow = this.renderStride(1.15) > 1;
      if (denseFlow) {
        const drawState = (target: "BULLISH" | "BEARISH" | "NEUTRAL", color: number, halo: boolean) => {
          let drew = false;
          for (let cursor = 1; cursor < indices.length; cursor++) {
            const previousIndex = indices[cursor - 1]!;
            const index = indices[cursor]!;
            const priorState = aligned(snapshot.series.flowState, previousIndex);
            const state = aligned(snapshot.series.flowState, index);
            const priorAnchor = aligned(snapshot.series.smoothedDrawdown, previousIndex);
            const anchor = aligned(snapshot.series.smoothedDrawdown, index);
            if (state !== target || priorState === "UNAVAILABLE" || !Number.isFinite(priorAnchor) || !Number.isFinite(anchor)) continue;
            g.moveTo(this.xForIndex(previousIndex), yForDrawdown(priorAnchor!));
            g.lineTo(this.xForIndex(index), yForDrawdown(anchor!));
            drew = true;
          }
          if (drew) g.stroke({
            width: settings.flowLineWidth + (halo ? 1.4 : 0),
            color: halo ? 0x020203 : color,
            alpha: halo ? Math.min(0.72, baseAlpha) : baseAlpha * 0.82
          });
        };
        for (const [state, color] of [["BULLISH", bullish], ["BEARISH", bearish], ["NEUTRAL", neutral]] as const) {
          drawState(state, color, true);
          drawState(state, color, false);
        }
      } else {
        for (let cursor = 1; cursor < indices.length; cursor++) {
          const previousIndex = indices[cursor - 1]!;
          const index = indices[cursor]!;
          const priorState = aligned(snapshot.series.flowState, previousIndex);
          const state = aligned(snapshot.series.flowState, index);
          const priorAnchor = aligned(snapshot.series.smoothedDrawdown, previousIndex);
          const anchor = aligned(snapshot.series.smoothedDrawdown, index);
          const pressure = aligned(snapshot.series.flowPressure, index);
          if (state === "UNAVAILABLE" || priorState === "UNAVAILABLE" || !Number.isFinite(priorAnchor) || !Number.isFinite(anchor) || !Number.isFinite(pressure)) continue;
          const color = state === "BULLISH" ? bullish : state === "BEARISH" ? bearish : neutral;
          const magnitude = Math.min(1, Math.abs(pressure!) / 100);
          const width = settings.flowLineWidth * (0.9 + magnitude * 0.65);
          const alpha = baseAlpha * (0.55 + magnitude * 0.45);
          const x1 = this.xForIndex(previousIndex);
          const x2 = this.xForIndex(index);
          const y1 = yForDrawdown(priorAnchor!);
          const y2 = yForDrawdown(anchor!);
          g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: width + 1.4, color: 0x020203, alpha: Math.min(0.78, alpha) });
          g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width, color, alpha });
        }
      }
    }

    if (settings.showRiskScore) {
      const barWidth = Math.max(0.5, Math.min(this.timeStep() * 0.65, 4));
      for (const index of this.renderIndices(1)) {
        const score = aligned(snapshot.series.riskScore, index);
        if (!Number.isFinite(score)) continue;
        const height = Math.max(1, paneHeight * 0.10 * (score! / 100));
        g.rect(this.xForIndex(index) - barWidth / 2, paneBottom - height, barWidth, height)
          .fill({ color: score! >= 90 ? this.hexColor(themePalette.extreme, theme.redBright) : score! >= 75 ? this.hexColor(themePalette.high, theme.red) : this.hexColor(themePalette.moderate, theme.silver), alpha: 0.34 });
      }
    }

    if (settings.showVelocity) drawLine(snapshot.series.velocity.map((value) => -Math.max(0, value)), this.hexColor(themePalette.extreme, theme.redBright), 0.48, 0.75);
    if (settings.showEpisodeMarkers) {
      const drawSignal = (signal: (typeof snapshot.signals)[number], radius: number, alpha: number, halo = false, hollow = false) => {
        const chartIndex = offset + signal.index;
        if (chartIndex < this.view.firstIndex || chartIndex > this.view.lastIndex) return;
        const color = signal.markerTone === "blood-red"
          ? this.hexColor("#ff1838", theme.redBright)
          : this.hexColor("#f2f2f4", theme.silverBright);
        const x = this.xForIndex(chartIndex);
        const y = yForDrawdown(snapshot.series.rawDrawdown[signal.index] ?? -signal.value);
        if (halo) g.circle(x, y, radius + 2.2).stroke({ width: 0.8, color, alpha: Math.min(0.62, alpha * 0.62) });
        if (hollow) g.circle(x, y, radius).stroke({ width: 1, color, alpha });
        else g.circle(x, y, radius).fill({ color, alpha });
        if (settings.showSignalConfidence && Number.isFinite(signal.confidence)) {
          this.addProfileText(`${Math.round(signal.confidence!)}%`, x + 5, y - 7, color, 7, "600");
        }
      };
      if (settings.signalIntelligenceMode === "RAW") {
        if (settings.showRawSignals) for (const signal of snapshot.rawSignals) drawSignal(signal, 2.8, 0.9);
        if (settings.showProvisionalSignals) for (const signal of snapshot.signalIntelligence.provisionalSignals) drawSignal(signal, 2.1, 0.65, false, true);
      } else {
        const primaryKeys = new Set([
          ...snapshot.signals.map((signal) => `${signal.index}:${signal.direction}`),
          ...snapshot.signalIntelligence.provisionalSignals.map((signal) => `${signal.index}:${signal.direction}`)
        ]);
        if (settings.showRawSignals) for (const signal of snapshot.signalIntelligence.rawCandidateSignals) {
          if (!primaryKeys.has(`${signal.index}:${signal.direction}`)) drawSignal(signal, 1.45, 0.24);
        }
        if (settings.showProvisionalSignals) for (const signal of snapshot.signalIntelligence.provisionalSignals) drawSignal(signal, 1.9, 0.42);
        if (settings.showConfirmedSignals) for (const signal of snapshot.signals) drawSignal(signal, 2.8, 0.94, (signal.confidence ?? 0) >= 82);
      }
    }

    const dashboardOnLeft = settings.dashboardPosition.endsWith("left");
    const dashboardOnBottom = settings.dashboardPosition.startsWith("bottom");
    const dashboardPanelWidth = Math.min(300, Math.max(228, plotWidth - 24));
    const flowDashboardRow = settings.showFlowPressure ? 1 : 0;
    const dashboardRows = paneHeight >= 145 ? (settings.showExpandedDashboard ? 8 + flowDashboardRow : 3 + flowDashboardRow) : 1;
    const dashboardPanelHeight = dashboardRows === 9 ? 127 : dashboardRows === 8 ? 113 : dashboardRows === 4 ? 57 : dashboardRows === 3 ? 43 : 23;
    const dashboardX = Math.round(dashboardOnLeft ? 12 : Math.max(12, plotWidth - dashboardPanelWidth - 12));
    const dashboardY = Math.round(dashboardOnBottom
      ? Math.max(paneTop + 24, paneBottom - dashboardPanelHeight - 7)
      : dashboardOnLeft ? paneTop + 24 : paneTop + 8);
    const dashboardTextColor = this.hexColor(themePalette.low, theme.silverBright);
    const addDashboardText = (text: string, y: number, color = dashboardTextColor, size = 9, weight: "500" | "600" | "700" = "600") =>
      this.addProfileText(text, dashboardX, y, color, size, weight, true);
    this.addProfileText(`BC-RDA · ${snapshot.signalIntegrity.legacyResearchOnly ? "LEGACY REPAINTING · RESEARCH ONLY" : "CAUSAL V2 · ALERTS/STRATEGY BLOCKED"}`, 12, paneTop + 7, snapshot.signalIntegrity.legacyResearchOnly ? theme.redBright : this.hexColor(themePalette.text, theme.silverBright), 10, "700", true);
    if (settings.showRegimeDiagnostics && settings.signalIntelligenceMode !== "RAW" && paneHeight >= 92) {
      const intelligence = snapshot.signalIntelligence;
      const latestIndex = Math.max(0, snapshot.inputSize - 1);
      const regime = intelligence.regime[latestIndex] ?? "UNCLASSIFIED";
      const diagnostics = `${regime} ${Math.round(intelligence.regimeConfidence[latestIndex] ?? 0)} · L ${Math.round(intelligence.longConfidence[latestIndex] ?? 0)} S ${Math.round(intelligence.shortConfidence[latestIndex] ?? 0)} · CHOP ${Math.round(intelligence.chopProbability[latestIndex] ?? 0)} · ${intelligence.longState[latestIndex] ?? "NEUTRAL"}/${intelligence.shortState[latestIndex] ?? "NEUTRAL"}`;
      this.addProfileText(diagnostics, 12, paneTop + 20, this.hexColor(themePalette.low, theme.silver), 8, "600", true);
      if (paneHeight >= 112) {
        const featureLine = `COH ${Math.round(intelligence.coherence[latestIndex] ?? 0)} · V ${Number(intelligence.centroidVelocity[latestIndex] ?? 0).toFixed(3)} A ${Number(intelligence.centroidAcceleration[latestIndex] ?? 0).toFixed(3)} · EXP ${Math.round(intelligence.expansionScore[latestIndex] ?? 0)} · TAIL ${Math.round(intelligence.tailAsymmetry[latestIndex] ?? 0)}`;
        this.addProfileText(featureLine, 12, paneTop + 32, this.hexColor(themePalette.low, theme.silver), 8, "600", true);
      }
      if (paneHeight >= 132) {
        const latestSignal = snapshot.signals.at(-1);
        const barsSince = latestSignal ? Math.max(0, latestIndex - latestSignal.index) : null;
        const episode = latestSignal?.episodeId?.slice(-18) ?? "NONE";
        const reasons = intelligence.latestReasonCodes.slice(0, 2).join("/") || "NO_ACTIVE_REJECTION";
        this.addProfileText(`EP ${episode} · LAST ${barsSince ?? "--"} BARS · ${reasons}`, 12, paneTop + 44, this.hexColor(themePalette.low, theme.silver), 8, "600", true);
      }
    }
    if (settings.showDashboard) {
      const panelX = dashboardX - 7;
      const panelY = dashboardY - 6;
      g.roundRect(panelX, panelY, dashboardPanelWidth + 14, dashboardPanelHeight, 3)
        .fill({ color: 0x030405, alpha: 0.9 })
        .stroke({ width: 1, color: 0xd9dce2, alpha: 0.18 });
      g.rect(panelX, panelY + 1, 2, dashboardPanelHeight - 2).fill({ color: riskColor, alpha: 0.9 });
      addDashboardText(`${snapshot.latest.riskState} ${snapshot.latest.riskScore.toFixed(1)} · DD ${snapshot.latest.drawdownPercent.toFixed(2)}% · MDD ${snapshot.latest.maxDrawdownPercent.toFixed(2)}%`, dashboardY, riskColor, 10, "700");
    }
    if (settings.showDashboard && paneHeight >= 145 && snapshot.signalIntegrity.legacyResearchOnly) {
      addDashboardText("LEGACY PERFORMANCE INVALID · REPAINTING SOURCE", dashboardY + 14, theme.redBright, 9, "700");
      addDashboardText("ALERTS · BACKTEST · AUTOMATION BLOCKED", dashboardY + 28, theme.redBright, 9, "700");
    } else if (settings.showDashboard && paneHeight >= 145) {
      const rowOffset = settings.showFlowPressure ? 14 : 0;
      if (settings.showFlowPressure) {
        const flowColor = snapshot.latest.flowState === "BULLISH"
          ? this.hexColor(settings.flowBullishColor, theme.silverBright)
          : snapshot.latest.flowState === "BEARISH"
            ? this.hexColor(settings.flowBearishColor, theme.redBright)
            : this.hexColor(settings.flowNeutralColor, theme.muted);
        const flowValue = snapshot.latest.flowState === "UNAVAILABLE" ? "--" : `${snapshot.latest.flowPressure >= 0 ? "+" : ""}${snapshot.latest.flowPressure.toFixed(1)}`;
        addDashboardText(`FLOW ${flowValue} ${snapshot.latest.flowState} · COV ${snapshot.latest.flowCoveragePercent.toFixed(0)}%`, dashboardY + 14, flowColor);
      }
      addDashboardText("PCTL " + snapshot.latest.percentileRank.toFixed(1) + "   Z " + snapshot.latest.zScore.toFixed(2) + "   TUW " + snapshot.latest.timeUnderWaterBars, dashboardY + 14 + rowOffset);
      addDashboardText("SH " + snapshot.latest.sharpe.toFixed(2) + "   SO " + snapshot.latest.sortino.toFixed(2) + "   CA " + snapshot.latest.calmar.toFixed(2) + "   CONF " + snapshot.latest.confidence.toFixed(0) + "%", dashboardY + 28 + rowOffset);
      if (settings.showExpandedDashboard) {
        const latestIndex = Math.max(0, snapshot.inputSize - 1);
        addDashboardText("P95 " + Math.abs(snapshot.series.p95[latestIndex] ?? 0).toFixed(2) + "%   P99 " + Math.abs(snapshot.series.p99[latestIndex] ?? 0).toFixed(2) + "%   VADD " + snapshot.latest.vadd.toFixed(2), dashboardY + 42 + rowOffset);
        addDashboardText("VaR95 " + snapshot.latest.returnVaR95Percent.toFixed(2) + "%   ES95 " + snapshot.latest.returnES95Percent.toFixed(2) + "%", dashboardY + 56 + rowOffset);
        addDashboardText("DaR95 " + snapshot.latest.drawdownAtRisk95Percent.toFixed(2) + "%   CDaR95 " + snapshot.latest.conditionalDrawdownAtRisk95Percent.toFixed(2) + "%", dashboardY + 70 + rowOffset);
        addDashboardText("ULCER " + snapshot.latest.ulcerIndex.toFixed(2) + "   PAIN " + snapshot.latest.painIndex.toFixed(2) + "   OMEGA " + snapshot.latest.omegaRatio.toFixed(2), dashboardY + 84 + rowOffset);
        addDashboardText("RECOVERY " + snapshot.latest.recoveryFactor.toFixed(2) + "   AUW " + (snapshot.episodes.at(-1)?.areaUnderWater.toFixed(2) ?? "0.00"), dashboardY + 98 + rowOffset);
      }
    }
  }

  private cvdOscillatorSnapshotFor(data: Candle[]) {
    const settings = migrateCvdOscillatorSettings({
      ...this.indicatorAdvancedSettings.cvdOscillator,
      lookback: this.indicatorPeriods.cvdOscillator
    });
    const timeframeSeconds = data.length >= 2
      ? Math.max(1, Math.round(data[data.length - 1]!.time - data[data.length - 2]!.time))
      : 60;
    const authenticRevision = settings.useAuthenticAggressorFlow
      ? `${this.acvdSnapshot?.authority ?? "NONE"}:${this.acvdSnapshot?.dataHash ?? "NONE"}`
      : "OHLCV";
    const key = `${this.volumeProfileDataVersion}:${timeframeSeconds}:${authenticRevision}:${JSON.stringify(settings)}`;
    if (this.cvdOscillatorCache?.key === key) return this.cvdOscillatorCache.snapshot;
    const snapshot = calculateCvdOscillator({
      candles: data,
      settings,
      timeframeSeconds,
      authenticSnapshot: settings.useAuthenticAggressorFlow ? this.acvdSnapshot : null
    });
    this.cvdOscillatorCache = { key, snapshot };
    return snapshot;
  }

  private drawCvdOscillatorPane(data: Candle[], paneTop: number, paneBottom: number, plotWidth: number) {
    const settings = migrateCvdOscillatorSettings({
      ...this.indicatorAdvancedSettings.cvdOscillator,
      lookback: this.indicatorPeriods.cvdOscillator
    });
    const snapshot = this.cvdOscillatorSnapshotFor(data);
    const g = this.indicatorLayer;
    const paneHeight = paneBottom - paneTop;
    const offset = Math.max(0, data.length - snapshot.inputSize);
    const indices = this.renderIndices(1).filter((index) => index >= offset);
    const fastColor = this.hexColor(settings.fastWaveColor, theme.silverBright);
    const slowColor = this.hexColor(settings.slowWaveColor, theme.red);
    const rawColor = this.hexColor(settings.rawCvdColor, theme.silver);
    const statusColor = snapshot.latest.state === "LONG"
      ? theme.green
      : snapshot.latest.state === "SHORT"
        ? theme.redBright
        : theme.muted;

    g.rect(0, paneTop, plotWidth, paneHeight)
      .fill({ color: 0x010102, alpha: 0.99 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.07 });

    if (snapshot.authority === "UNAVAILABLE") {
      this.addProfileText("BC-CVD-OSC · AUTHENTIC AGGRESSOR FLOW UNAVAILABLE", 12, paneTop + 9, theme.redBright, 9, "700", true);
      this.addProfileText(snapshot.warning ?? "Waiting for certified venue-matched aggressor trades. OHLCV fallback was not substituted.", 12, paneTop + 25, theme.muted, 8, "500");
      return;
    }

    const sourceIndex = (chartIndex: number) => chartIndex - offset;
    const aligned = (values: readonly number[], chartIndex: number) => values[sourceIndex(chartIndex)] ?? Number.NaN;
    const domainValues: number[] = [];
    for (const chartIndex of indices) {
      for (const values of [snapshot.series.cvd, snapshot.series.fast, snapshot.series.slow, snapshot.series.upperCloud, snapshot.series.lowerCloud]) {
        const value = aligned(values, chartIndex);
        if (Number.isFinite(value)) domainValues.push(value);
      }
    }
    let minimum = domainValues.length ? Number.POSITIVE_INFINITY : -1;
    let maximum = domainValues.length ? Number.NEGATIVE_INFINITY : 1;
    for (const value of domainValues) {
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    if (!(maximum > minimum)) { minimum -= 1; maximum += 1; }
    const padding = (maximum - minimum) * 0.08;
    minimum -= padding;
    maximum += padding;
    const yFor = (value: number) => paneBottom - 9 - ((value - minimum) / (maximum - minimum)) * Math.max(1, paneHeight - 25);

    if (settings.showClouds) {
      let segment: number[] = [];
      const flush = () => {
        if (segment.length < 2) { segment = []; return; }
        const polygon: number[] = [];
        for (const chartIndex of segment) polygon.push(this.xForIndex(chartIndex), yFor(aligned(snapshot.series.upperCloud, chartIndex)));
        for (let cursor = segment.length - 1; cursor >= 0; cursor--) {
          const chartIndex = segment[cursor]!;
          polygon.push(this.xForIndex(chartIndex), yFor(aligned(snapshot.series.lowerCloud, chartIndex)));
        }
        g.poly(polygon).fill({ color: slowColor, alpha: clampNumber(settings.cloudIntensity / 100, 0, 0.4) });
        segment = [];
      };
      for (const chartIndex of indices) {
        const upper = aligned(snapshot.series.upperCloud, chartIndex);
        const lower = aligned(snapshot.series.lowerCloud, chartIndex);
        if (!Number.isFinite(upper) || !Number.isFinite(lower)) flush();
        else segment.push(chartIndex);
      }
      flush();
    }

    const drawLine = (values: readonly number[], color: number, width: number, alpha: number) => {
      let active = false;
      for (const chartIndex of indices) {
        const value = aligned(values, chartIndex);
        if (!Number.isFinite(value)) { active = false; continue; }
        const x = this.xForIndex(chartIndex);
        const y = yFor(value);
        if (!active) { g.moveTo(x, y); active = true; }
        else g.lineTo(x, y);
      }
      if (active) g.stroke({ width, color, alpha });
    };

    if (settings.showRawCvd) drawLine(snapshot.series.cvd, rawColor, 0.85, settings.rawCvdIntensity / 100);
    drawLine(snapshot.series.slow, slowColor, settings.slowWaveWidth + 1.5, settings.slowWaveIntensity / 100 * 0.16);
    drawLine(snapshot.series.slow, slowColor, settings.slowWaveWidth, settings.slowWaveIntensity / 100);
    drawLine(snapshot.series.fast, fastColor, settings.fastWaveWidth + 1.5, settings.fastWaveIntensity / 100 * 0.18);
    drawLine(snapshot.series.fast, fastColor, settings.fastWaveWidth, settings.fastWaveIntensity / 100);

    const authentic = snapshot.authority === "EXACT_AGGRESSOR_TRADES";
    this.addProfileText(`BC-CVD-OSC · ${authentic ? "AUTHENTIC AGGRESSOR" : "CANDLE-SIGNED"} CVD MARKET STATE`, 12, paneTop + 7, theme.silverBright, 9, "700", true);
    this.addProfileText(`FAST ${snapshot.lengths.fast} · SLOW ${snapshot.lengths.slow} · ${authentic ? `EXACT FLOW · COV ${snapshot.coveragePercent.toFixed(0)}%` : "OHLCV ESTIMATE"}`, 12, paneTop + 21, theme.muted, 8, "600", true);

    if (settings.showStatusPanel) {
      const panelWidth = Math.min(settings.statusPanelWidth, Math.max(170, plotWidth - 24));
      const panelX = Math.max(8, plotWidth - panelWidth - 10);
      const panelY = paneTop + 8;
      g.roundRect(panelX, panelY, panelWidth, 49, 4)
        .fill({ color: 0x020203, alpha: 0.94 })
        .stroke({ width: 1, color: statusColor, alpha: 0.6 });
      g.rect(panelX, panelY + 1, 3, 47).fill({ color: statusColor, alpha: 0.92 });
      this.addProfileText("MARKET STATUS", panelX + 11, panelY + 7, theme.muted, 8, "700", true);
      this.addProfileText(snapshot.latest.state, panelX + 11, panelY + 22, statusColor, 12, "700", true);
      this.addProfileText(authentic ? "EXACT AGGRESSOR CVD" : "OHLCV-SIGNED CVD", panelX + panelWidth - (authentic ? 112 : 96), panelY + 25, theme.muted, 7, "600", true);
    }
  }

  private marketSentimentSnapshotFor(data: Candle[]) {
    const settings = migrateMarketSentimentSettings({
      ...this.indicatorAdvancedSettings.marketSentimentOscillator,
      lookback: this.indicatorPeriods.marketSentimentOscillator
    });
    const key = `${this.volumeProfileDataVersion}:${JSON.stringify(settings)}`;
    if (this.marketSentimentCache?.key === key) return this.marketSentimentCache.snapshot;
    const snapshot = calculateMarketSentiment({ candles: data, settings, lastBarConfirmed: true });
    this.marketSentimentCache = { key, snapshot };
    return snapshot;
  }

  private drawMarketSentimentPane(data: Candle[], paneTop: number, paneBottom: number, plotWidth: number) {
    const snapshot = this.marketSentimentSnapshotFor(data);
    const settings = snapshot.settings;
    const g = this.indicatorLayer;
    const paneHeight = paneBottom - paneTop;
    const offset = Math.max(0, data.length - snapshot.inputSize);
    const indices = this.renderIndices(1).filter((index) => index >= offset);
    const bullish = this.hexColor(settings.bullishColor, theme.silverBright);
    const bearish = this.hexColor(settings.bearishColor, theme.redBright);
    const neutral = this.hexColor(settings.neutralColor, theme.muted);
    const lineColor = this.hexColor(settings.lineColor, theme.silverBright);
    const chartIndexToSource = (index: number) => index - offset;
    const aligned = (values: readonly (number | null)[], index: number) => values[chartIndexToSource(index)] ?? null;
    const finiteValue = (value: number | null): value is number => typeof value === "number" && Number.isFinite(value);
    const yFor = (value: number) => paneBottom - 11 - clampNumber(value / 10, 0, 1) * Math.max(1, paneHeight - 29);
    const adaptiveMode = settings.calculationMode !== "ORIGINAL_COMPOSITE";

    g.rect(0, paneTop, plotWidth, paneHeight)
      .fill({ color: 0x010102, alpha: 0.99 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.07 });

    if (settings.showBandFill && !adaptiveMode) {
      g.rect(0, yFor(10), plotWidth, Math.max(1, yFor(settings.overbought) - yFor(10)))
        .fill({ color: bearish, alpha: clampNumber(settings.bandFillIntensity / 100, 0, 0.4) });
      g.rect(0, yFor(settings.oversold), plotWidth, Math.max(1, yFor(0) - yFor(settings.oversold)))
        .fill({ color: bullish, alpha: clampNumber(settings.bandFillIntensity / 100, 0, 0.3) });
    }
    const referenceLines = adaptiveMode
      ? [[10, neutral, 0.22], [5, neutral, 0.36], [0, neutral, 0.22]] as const
      : [[10, neutral, 0.22], [settings.overbought, bearish, settings.bandIntensity / 100], [5, neutral, 0.36], [settings.oversold, bullish, settings.bandIntensity / 100], [0, neutral, 0.22]] as const;
    for (const [value, color, alpha] of referenceLines) {
      g.moveTo(0, yFor(value)).lineTo(plotWidth, yFor(value)).stroke({ width: 1, color, alpha });
    }
    if (adaptiveMode && settings.showDynamicBands) {
      const bandColumnWidth = Math.max(1, this.timeStep() * Math.max(1, this.renderStride(1)));
      if (settings.showBandFill) {
        for (const chartIndex of indices) {
          const upper = aligned(snapshot.series.dynamicUpper, chartIndex);
          const lower = aligned(snapshot.series.dynamicLower, chartIndex);
          if (!finiteValue(upper) || !finiteValue(lower)) continue;
          const x = this.xForIndex(chartIndex) - bandColumnWidth / 2;
          g.rect(x, yFor(10), bandColumnWidth + 0.5, Math.max(1, yFor(upper) - yFor(10)))
            .fill({ color: bearish, alpha: clampNumber(settings.bandFillIntensity / 100, 0, 0.4) });
          g.rect(x, yFor(lower), bandColumnWidth + 0.5, Math.max(1, yFor(0) - yFor(lower)))
            .fill({ color: bullish, alpha: clampNumber(settings.bandFillIntensity / 100, 0, 0.3) });
        }
      }
      const drawAdaptiveBand = (values: readonly (number | null)[], color: number) => {
        let active = false;
        for (const chartIndex of indices) {
          const value = aligned(values, chartIndex);
          if (!finiteValue(value)) { active = false; continue; }
          const x = this.xForIndex(chartIndex);
          const y = yFor(value);
          if (!active) { g.moveTo(x, y); active = true; } else g.lineTo(x, y);
        }
        if (active) g.stroke({ width: 1.1, color, alpha: settings.bandIntensity / 100 });
      };
      drawAdaptiveBand(snapshot.series.dynamicUpper, bearish);
      drawAdaptiveBand(snapshot.series.dynamicLower, bullish);
    }

    if (settings.candleView) {
      const bodyWidth = Math.max(1, Math.min(7, this.timeStep() * 0.68));
      const alpha = settings.candleIntensity / 100;
      for (const chartIndex of indices) {
        const sourceIndex = chartIndexToSource(chartIndex);
        const open = aligned(snapshot.series.candleOpen, chartIndex);
        const high = aligned(snapshot.series.candleHigh, chartIndex);
        const low = aligned(snapshot.series.candleLow, chartIndex);
        const close = aligned(snapshot.series.candleClose, chartIndex);
        if (![open, high, low, close].every((value) => typeof value === "number" && Number.isFinite(value))) continue;
        const color = snapshot.series.candleDirection[sourceIndex] < 0 ? bearish : bullish;
        const x = this.xForIndex(chartIndex);
        const top = Math.min(yFor(open!), yFor(close!));
        const bottom = Math.max(yFor(open!), yFor(close!));
        g.moveTo(x, yFor(high!)).lineTo(x, yFor(low!)).stroke({ width: 0.8, color, alpha: alpha * 0.82 });
        g.rect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top)).fill({ color, alpha });
      }
    } else {
      let active = false;
      for (const chartIndex of indices) {
        const value = aligned(snapshot.series.sentiment, chartIndex);
        if (typeof value !== "number" || !Number.isFinite(value)) { active = false; continue; }
        const x = this.xForIndex(chartIndex);
        const y = yFor(value);
        if (!active) { g.moveTo(x, y); active = true; } else g.lineTo(x, y);
      }
      if (active) g.stroke({ width: settings.lineWidth, color: lineColor, alpha: settings.lineIntensity / 100 });
    }

    if (adaptiveMode && settings.showRawComposite) {
      let active = false;
      for (const chartIndex of indices) {
        const value = aligned(snapshot.series.rawSentiment, chartIndex);
        if (!finiteValue(value)) { active = false; continue; }
        const x = this.xForIndex(chartIndex);
        const y = yFor(value);
        if (!active) { g.moveTo(x, y); active = true; } else g.lineTo(x, y);
      }
      if (active) g.stroke({ width: 0.8, color: neutral, alpha: 0.38 });
    }

    for (const event of snapshot.events) {
      const chartIndex = offset + event.index;
      if (chartIndex < this.view.firstIndex || chartIndex > this.view.lastIndex) continue;
      const isOverbought = event.kind.includes("OVERBOUGHT");
      const isEntry = event.kind.startsWith("ENTER");
      const adaptiveSignal = event.kind.startsWith("CONFIRMED_ADAPTIVE");
      const shortSignal = event.kind === "CONFIRMED_ADAPTIVE_SHORT";
      const color = adaptiveSignal ? (shortSignal ? bearish : bullish) : (isOverbought ? bearish : bullish);
      const y = yFor(event.score);
      const x = this.xForIndex(chartIndex);
      if (adaptiveSignal) {
        g.circle(x, y, 4.6).fill({ color, alpha: 0.16 });
        g.circle(x, y, 3.1).fill({ color, alpha: 1 });
      } else if (isEntry) g.circle(x, y, 2.7).fill({ color, alpha: 0.98 });
      else g.circle(x, y, 2.5).stroke({ width: 1, color, alpha: 0.88 });
    }

    const modeLabel = settings.calculationMode === "ADAPTIVE_EVT" ? "ADAPTIVE EXTREME VALUE" : settings.calculationMode === "REGIME_PERCENTILE" ? "REGIME PERCENTILE" : "PYTHON COMPOSITE";
    this.addProfileText(`BC-MSO · ${modeLabel} SENTIMENT`, 12, paneTop + 7, theme.silverBright, 9, "700", true);
    const latestScore = snapshot.latest.score;
    const statusColor = snapshot.latest.zone === "OVERBOUGHT" ? bearish : snapshot.latest.zone === "OVERSOLD" ? bullish : neutral;
    const calibration = adaptiveMode ? ` · ${snapshot.latest.regime} · N${snapshot.latest.calibrationSamples}${snapshot.latest.evtActive ? " · EVT TAIL" : settings.calculationMode === "ADAPTIVE_EVT" ? " · EMPIRICAL" : ""}` : "";
    const status = latestScore === null ? "WARMING UP" : `${snapshot.latest.zone} · ${latestScore.toFixed(2)} / 10${calibration}`;
    this.addProfileText(status, Math.max(12, plotWidth - Math.min(270, 142 + calibration.length * 3.5)), paneTop + 7, statusColor, 8, "700", true);
  }

  private drawAcvdPane(data: Candle[], paneTop: number, paneBottom: number, plotWidth: number) {
    const snapshot = this.acvdSnapshot;
    const settings = this.indicatorAdvancedSettings.acvdOscillator;
    const g = this.indicatorLayer;
    const height = paneBottom - paneTop;
    const bullish = this.hexColor(settings.bullishColor, theme.silverBright);
    const bearish = this.hexColor(settings.bearishColor, theme.red);
    const neutral = this.hexColor(settings.neutralColor, theme.muted);
    const envelopeColor = this.hexColor(settings.envelopeColor, theme.silver);
    const lineAlpha = clampNumber(settings.lineIntensity / 100, 0, 1);
    const fillAlpha = clampNumber(settings.fillIntensity / 100, 0, 0.48);

    g.rect(0, paneTop, plotWidth, height)
      .fill({ color: 0x010102, alpha: 0.985 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.07 });
    const zeroY = this.acvdValueToY(0, paneTop, paneBottom);
    g.moveTo(0, zeroY).lineTo(plotWidth, zeroY).stroke({ width: 1, color: neutral, alpha: 0.28 });

    if (!snapshot || snapshot.inputSize === 0) {
      this.addProfileText("BC-ACVD · CALCULATING AUTHENTIC DELTA", 12, paneTop + 9, theme.silverBright, 9, "700", true);
      return;
    }
    if (snapshot.authority !== "EXACT_AGGRESSOR_TRADES") {
      this.addProfileText("BC-ACVD · AUTHENTIC FLOW UNAVAILABLE", 12, paneTop + 9, theme.redBright, 9, "700", true);
      this.addProfileText(snapshot.warning ?? "Waiting for venue-matched classified aggressor trades.", 12, paneTop + 25, theme.muted, 8, "500");
      return;
    }

    const offset = Math.max(0, data.length - snapshot.inputSize);
    const renderIndices = this.renderIndices(1);
    const aligned = (values: readonly number[], chartIndex: number) => {
      const sourceIndex = chartIndex - offset;
      return sourceIndex >= 0 && sourceIndex < values.length ? values[sourceIndex] : Number.NaN;
    };
    const drawLine = (values: readonly number[], color: number, alpha: number, width: number) => {
      for (const segment of acvdContiguousFiniteSegments(renderIndices, offset, [values])) {
        if (segment.length < 2) continue;
        const firstIndex = segment[0]!;
        g.moveTo(this.xForIndex(firstIndex), this.acvdValueToY(aligned(values, firstIndex), paneTop, paneBottom));
        for (let cursor = 1; cursor < segment.length; cursor++) {
          const chartIndex = segment[cursor]!;
          g.lineTo(this.xForIndex(chartIndex), this.acvdValueToY(aligned(values, chartIndex), paneTop, paneBottom));
        }
        g.stroke({ width, color, alpha });
      }
    };

    if (settings.showDeltaHistogram) {
      const barWidth = Math.max(0.5, Math.min(this.timeStep() * 0.72, 5));
      for (const chartIndex of renderIndices) {
        const impulse = aligned(snapshot.series.deltaImpulse, chartIndex);
        if (!Number.isFinite(impulse)) continue;
        const y = this.acvdValueToY(clampNumber(impulse * 2.2, -100, 100), paneTop, paneBottom);
        g.rect(this.xForIndex(chartIndex) - barWidth / 2, Math.min(y, zeroY), barWidth, Math.max(1, Math.abs(y - zeroY)))
          .fill({ color: impulse >= 0 ? bullish : bearish, alpha: 0.08 + fillAlpha * 0.68 });
      }
    }

    if (settings.showDynamicEnvelope) {
      const envelopeSegments = acvdContiguousFiniteSegments(renderIndices, offset, [
        snapshot.series.upperEnvelope,
        snapshot.series.lowerEnvelope
      ]);
      for (const segment of envelopeSegments) {
        if (segment.length < 2) continue;
        const polygon: number[] = [];
        for (const chartIndex of segment) {
          polygon.push(
            this.xForIndex(chartIndex),
            this.acvdValueToY(aligned(snapshot.series.upperEnvelope, chartIndex), paneTop, paneBottom)
          );
        }
        for (let cursor = segment.length - 1; cursor >= 0; cursor--) {
          const chartIndex = segment[cursor]!;
          polygon.push(
            this.xForIndex(chartIndex),
            this.acvdValueToY(aligned(snapshot.series.lowerEnvelope, chartIndex), paneTop, paneBottom)
          );
        }
        g.poly(polygon).fill({ color: envelopeColor, alpha: fillAlpha * 0.34 });
      }
      drawLine(snapshot.series.upperEnvelope, bearish, lineAlpha * 0.46, 0.9);
      drawLine(snapshot.series.lowerEnvelope, bullish, lineAlpha * 0.46, 0.9);
      drawLine(snapshot.series.center, neutral, lineAlpha * 0.32, 0.75);
    }

    if (settings.showAdaptivePressure) {
      drawLine(snapshot.series.adaptivePressure, neutral, lineAlpha * 0.32, Math.max(2.2, settings.lineWidth + 1.4));
      drawLine(snapshot.series.adaptivePressure, theme.silverBright, lineAlpha, settings.lineWidth);
    }

    if (settings.showSignals) {
      for (const signal of snapshot.signals) {
        const chartIndex = offset + signal.index;
        if (chartIndex < this.view.firstIndex || chartIndex > this.view.lastIndex) continue;
        const x = this.xForIndex(chartIndex);
        const y = this.acvdValueToY(signal.pressure, paneTop, paneBottom);
        const color = signal.direction === "long" ? bullish : bearish;
        g.circle(x, y, 5.1).fill({ color, alpha: 0.13 });
        g.circle(x, y, 2.6).fill({ color, alpha: 0.98 });
        g.circle(x, y, 4).stroke({ width: 0.8, color, alpha: 0.68 });
      }
    }

    this.addProfileText("BC-ACVD · ADAPTIVE CAUSAL VOLUME DELTA", 12, paneTop + 7, theme.silverBright, 9, "700", true);
    if (settings.showDashboard) {
      const dashboardWidth = 245;
      const x = Math.max(8, plotWidth - dashboardWidth - 10);
      const y = paneTop + 7;
      g.roundRect(x, y, dashboardWidth, settings.showRegimeDiagnostics ? 47 : 30, 3)
        .fill({ color: 0x020203, alpha: 0.91 })
        .stroke({ width: 1, color: snapshot.latest.state === "BEARISH" ? bearish : snapshot.latest.state === "BULLISH" ? bullish : neutral, alpha: 0.46 });
      const signedPressure = `${snapshot.latest.pressure >= 0 ? "+" : ""}${snapshot.latest.pressure.toFixed(1)}`;
      this.addProfileText(`${snapshot.latest.state} · Δ ${signedPressure} · COV ${snapshot.latest.coveragePercent.toFixed(0)}%`, x + 7, y + 6, snapshot.latest.state === "BEARISH" ? bearish : snapshot.latest.state === "BULLISH" ? bullish : neutral, 8, "700", true);
      if (settings.showRegimeDiagnostics) {
        this.addProfileText(`${snapshot.latest.regime} · CHOP ${snapshot.latest.chopProbability.toFixed(0)} · L ${snapshot.latest.longConfidence.toFixed(0)} / S ${snapshot.latest.shortConfidence.toFixed(0)}`, x + 7, y + 23, theme.muted, 8, "600", true);
      }
    }
  }

  private drawOscillatorPanes(data: Candle[]) {
    const stack = this.oscillatorStackLayout();
    const customOscillatorPlots = this.customPlots.filter((plot) => plot.pane === "oscillator" && plot.visible !== false);
    if (stack.panes.length === 0 && stack.customPanes.length === 0) return;

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
      if (pane.key === "acvdOscillator") {
        this.drawAcvdPane(data, paneTop, paneBottom, plotWidth);
        continue;
      }
      if (pane.key === "cvdOscillator") {
        this.drawCvdOscillatorPane(data, paneTop, paneBottom, plotWidth);
        continue;
      }
      if (pane.key === "marketSentimentOscillator") {
        this.drawMarketSentimentPane(data, paneTop, paneBottom, plotWidth);
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
        key: "openInterestOscillator" | "zScoreOscillator" | "waveTrendOscillator" | "ddaProOscillator" | "acvdOscillator" | "cvdOscillator" | "marketSentimentOscillator";
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
      let observedMaxAbs = isZScorePane ? Math.max(Math.abs(zUpper), Math.abs(zLower), 1) : 1;
      for (const item of series) {
        for (let index = this.view.firstIndex; index <= this.view.lastIndex; index++) {
          const value = item.values[index];
          if (Number.isFinite(value)) observedMaxAbs = Math.max(observedMaxAbs, Math.abs(value!));
        }
      }
      const maxAbs = Math.max(60, Math.min(288, observedMaxAbs * 1.16));
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
          for (const i of this.renderIndices(1)) {
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
        for (const i of this.renderIndices(1)) {
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

    for (const customPane of stack.customPanes) {
      const scriptPlots = customOscillatorPlots.filter(
        (plot) => customOscillatorScriptId(plot.name) === customPane.scriptId
      );
      if (scriptPlots.length === 0) continue;
      const paneHeight = customPane.height;
      const paneBottom = basePaneBottom - customPane.bottomOffset;
      const paneTop = paneBottom - paneHeight;
      const visibleValues: number[] = [];
      for (const plot of scriptPlots) {
        const sourceOffset = Math.max(0, data.length - plot.values.length);
        for (let index = this.view.firstIndex; index <= this.view.lastIndex; index += 1) {
          const value = plot.values[index - sourceOffset];
          if (Number.isFinite(value)) visibleValues.push(value!);
        }
      }
      let domainMinimum = visibleValues.length ? Number.POSITIVE_INFINITY : -1;
      let domainMaximum = visibleValues.length ? Number.NEGATIVE_INFINITY : 1;
      for (const value of visibleValues) {
        domainMinimum = Math.min(domainMinimum, value);
        domainMaximum = Math.max(domainMaximum, value);
      }
      if (domainMinimum === domainMaximum) {
        const expansion = Math.abs(domainMinimum) * 0.05 || 1;
        domainMinimum -= expansion;
        domainMaximum += expansion;
      }
      const domainPadding = (domainMaximum - domainMinimum) * 0.08;
      domainMinimum -= domainPadding;
      domainMaximum += domainPadding;
      const yForCustomOscillator = (value: number) => paneBottom - (value - domainMinimum) / Math.max(1e-12, domainMaximum - domainMinimum) * paneHeight;

      g.rect(0, paneTop, plotWidth, paneHeight)
        .fill({ color: backgroundColor, alpha: Math.max(0.72, backgroundAlpha) })
        .stroke({ width: 1, color: theme.red, alpha: 0.18 });
      if (domainMinimum <= 0 && domainMaximum >= 0) {
        const zeroY = yForCustomOscillator(0);
        g.moveTo(0, zeroY).lineTo(plotWidth, zeroY).stroke({ width: 1, color: genericZeroColor, alpha: zeroLineAlpha });
      }

      for (const plot of scriptPlots) {
        const color = this.hexColor(plot.color, theme.silverBright);
        const sourceOffset = Math.max(0, data.length - plot.values.length);
        let started = false;
        for (const index of this.renderIndices(1)) {
          const value = plot.values[index - sourceOffset];
          if (!Number.isFinite(value)) {
            started = false;
            continue;
          }
          const x = this.xForIndex(index);
          const y = yForCustomOscillator(value!);
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else {
            g.lineTo(x, y);
          }
        }
        if (started) g.stroke({ width: plot.width || 1, color, alpha: 0.94 });
      }

      let labelX = 10;
      for (const plot of scriptPlots) {
        const color = this.hexColor(plot.color, theme.silverBright);
        const label = plot.name.includes(":") ? plot.name.slice(plot.name.indexOf(":") + 1) : plot.name;
        g.rect(labelX, paneTop + 9, Math.max(18, label.length * 5.6), 2).fill({ color, alpha: 0.8 });
        labelX += label.length * 6 + 22;
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
    const baseX = rightPlacement && settings.rangeMode === "fixed"
      ? plotWidth - 8
      : rightPlacement
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
    return resolveFixedLookbackWindow(data.length, settings.fixedRangeLength);
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

  private drawStackedStrategyLabel(
    g: Graphics,
    text: string,
    x: number,
    preferredY: number,
    color: number,
    lane: "above" | "below",
    labels: { x: number; y: number; width: number; height: number }[]
  ) {
    const size = 8;
    const step = size + 10;
    const primaryDirection = lane === "above" ? -1 : 1;
    for (const direction of [primaryDirection, -primaryDirection]) {
      for (let row = direction === primaryDirection ? 0 : 1; row < 14; row += 1) {
        if (this.drawStrategyLabel(g, text, x, preferredY + direction * row * step, color, size, labels)) return;
      }
    }
    // At an exceptionally dense chart edge, retaining the label is more
    // important than suppressing it. The compact fallback may overlap.
    this.drawStrategyLabel(g, text, x, preferredY, color, size);
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
      for (const index of this.renderIndices(1)) {
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
      for (const index of this.renderIndices(1)) {
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

      for (const index of this.renderIndices(1)) {
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
    const renderIndices = this.renderIndices(1).filter((index) => index >= first && index <= last);

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
      for (const index of renderIndices) {
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

      for (const index of renderIndices) {
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
        for (let cursor = 1; cursor < renderIndices.length; cursor++) {
          const previousIndex = renderIndices[cursor - 1]!;
          const index = renderIndices[cursor]!;
          const point = points[index];
          const previous = points[previousIndex];
          let crossesAnchor = false;
          for (let scan = previousIndex + 1; scan <= index; scan++) {
            if (points[scan]?.anchor) { crossesAnchor = true; break; }
          }
          if (
            point.direction !== target.direction
            || crossesAnchor
            || !isValid(point, "value")
            || !isValid(previous, "value")
          ) {
            continue;
          }
          g.moveTo(this.xForIndex(previousIndex), this.yForPrice(previous.value));
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
      for (const i of this.renderIndices(1)) {
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
      const values = this.cachedEmaSeries(data, period);
      let started = false;
      for (const i of this.renderIndices(1)) {
        const ema = values[i];
        if (!Number.isFinite(ema)) continue;
        const x = this.xForIndex(i);
        const y = this.yForPrice(ema!);
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
      const lowerForward: number[] = [];
      let midStarted = false;
      let upperStarted = false;
      let lowerStarted = false;

      for (const i of this.renderIndices(1)) {
        const mean = smaAt(i, period);
        const deviation = standardDeviationAt(i, period, mean) * 2;
        const x = this.xForIndex(i);
        const upperY = this.yForPrice(mean + deviation);
        const midY = this.yForPrice(mean);
        const lowerY = this.yForPrice(mean - deviation);

        upper.push(x, upperY);
        lowerForward.push(x, lowerY);

        if (!midStarted) {
          g.moveTo(x, midY);
          midStarted = true;
        } else {
          g.lineTo(x, midY);
        }
      }

      if (midStarted) g.stroke({ width: 1, color: visual.color, alpha: visual.alpha * 0.30 });

      for (const i of this.renderIndices(1)) {
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

      for (const i of this.renderIndices(1)) {
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

      if (upper.length > 4 && lowerForward.length > 4) {
        const polygon = [...upper];
        for (let cursor = lowerForward.length - 2; cursor >= 0; cursor -= 2) {
          polygon.push(lowerForward[cursor]!, lowerForward[cursor + 1]!);
        }
        g.poly(polygon).fill({ color: visual.color, alpha: visual.alpha * 0.035 });
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
      if (plot.pane === "oscillator" || plot.visible === false) continue;
      const color = this.hexColor(plot.color, 0x00ffcc);
      const sourceOffset = Math.max(0, data.length - plot.values.length);
      let started = false;
      for (const i of this.renderIndices(1)) {
        const val = plot.values[i - sourceOffset];
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

    if (this.customMarkers.length > 0) {
      const indexByTime = new Map(data.map((candle, index) => [candle.time, index]));
      const strategyLabels: { x: number; y: number; width: number; height: number }[] = [];
      for (const marker of this.customMarkers) {
        const index = indexByTime.get(marker.time);
        if (index === undefined || index < this.view.firstIndex || index > this.view.lastIndex) continue;
        const x = this.xForIndex(index);
        const priceY = this.yForPrice(marker.value);
        const color = this.hexColor(marker.color, marker.direction === "short" ? theme.redBright : theme.silverBright);

        // A marker's triangle is deliberately offset above/below the candle for
        // readability. This micro-tick remains on the exact finalized signal
        // price so Replay and live closed-bar signals can be audited visually.
        const signalPrice = Number.isFinite(marker.signalPrice) ? marker.signalPrice : data[index].close;
        const signalY = this.yForPrice(signalPrice);
        const signalHalfWidth = Math.max(1.4, Math.min(7, this.view.candleWidth * 0.48));
        g.moveTo(x - signalHalfWidth, signalY)
          .lineTo(x + signalHalfWidth, signalY)
          .stroke({ width: 3, color: 0x39ff88, alpha: 0.18 });
        g.moveTo(x - signalHalfWidth, signalY)
          .lineTo(x + signalHalfWidth, signalY)
          .stroke({ width: 1, color: 0x39ff88, alpha: 0.98 });

        const isStrategyFill = marker.kind === "entry" || marker.kind === "exit";
        const isLong = marker.direction === "long";
        let markerY = priceY;
        let labelLane: "above" | "below" = isLong ? "below" : "above";

        if (marker.kind === "entry") {
          markerY = priceY + (isLong ? 8 : -8);
          labelLane = isLong ? "below" : "above";
          const y = markerY;
          g.circle(x, y, 6).fill({ color, alpha: isLong ? 0.08 : 0.1 });
          g.poly(isLong
            ? [x, y - 5, x - 4, y + 3, x + 4, y + 3]
            : [x, y + 5, x - 4, y - 3, x + 4, y - 3]
          ).fill({ color, alpha: 0.98 }).stroke({ width: 0.8, color: 0x050506, alpha: 0.9 });
        } else if (marker.kind === "exit" && marker.strategyRole === "takeProfit") {
          markerY = priceY + (isLong ? -8 : 8);
          labelLane = isLong ? "above" : "below";
          this.drawStrategyDiamond(g, x, markerY, 4.4, color);
        } else if (marker.kind === "exit" && marker.strategyRole === "stopLoss") {
          markerY = priceY + (isLong ? 8 : -8);
          labelLane = isLong ? "below" : "above";
          g.circle(x, markerY, 4.2)
            .fill({ color, alpha: 0.92 })
            .stroke({ width: 1, color: 0x050506, alpha: 0.9 });
          g.moveTo(x - 2.2, markerY - 2.2).lineTo(x + 2.2, markerY + 2.2).stroke({ width: 1, color: 0xffffff, alpha: 0.86 });
          g.moveTo(x + 2.2, markerY - 2.2).lineTo(x - 2.2, markerY + 2.2).stroke({ width: 1, color: 0xffffff, alpha: 0.86 });
        } else if (marker.kind === "exit") {
          markerY = priceY + (isLong ? -7 : 7);
          labelLane = isLong ? "above" : "below";
          g.rect(x - 3.5, markerY - 3.5, 7, 7)
            .fill({ color, alpha: 0.92 })
            .stroke({ width: 0.8, color: 0x050506, alpha: 0.9 });
        } else if (marker.direction === "long") {
          const y = priceY + 8;
          g.circle(x, y, 6).fill({ color, alpha: 0.08 });
          g.poly([x, y - 5, x - 4, y + 3, x + 4, y + 3]).fill({ color, alpha: 0.98 }).stroke({ width: 0.8, color: 0x050506, alpha: 0.9 });
        } else if (marker.direction === "short") {
          const y = priceY - 8;
          g.circle(x, y, 6).fill({ color, alpha: 0.1 });
          g.poly([x, y + 5, x - 4, y - 3, x + 4, y - 3]).fill({ color, alpha: 0.98 }).stroke({ width: 0.8, color: 0x050506, alpha: 0.9 });
        } else {
          g.circle(x, priceY, 3.2).fill({ color, alpha: 0.94 }).stroke({ width: 0.8, color: 0x050506, alpha: 0.9 });
        }

        if (isStrategyFill) {
          const preferredY = markerY + (labelLane === "above" ? -21 : 7);
          this.drawStackedStrategyLabel(g, marker.label, x + 6, preferredY, color, labelLane, strategyLabels);
        }
      }
    }

    this.drawOscillatorPanes(data);
  }

  public setCustomPlots(plots: CompiledPlot[]) {
    this.customPlots = plots;
    this.draw();
  }

  public setCustomScriptOutput(plots: CompiledPlot[], markers: CompiledMarker[]) {
    this.customPlots = plots;
    this.customMarkers = markers;
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

    const stride = this.renderStride(1);
    const buckets = aggregateCandleRenderBuckets(data, this.view.firstIndex, this.view.lastIndex, stride);
    const maxVol = buckets.reduce((maximum, bucket) => Math.max(maximum, bucket.candle.volume), 1);
    const visual = this.visualFor("volume", "red");

    for (const bucket of buckets) {
      const c = bucket.candle;
      const barWidth = Math.max(0.55, Math.min(5, this.timeStep() * stride * 0.78));
      const x = this.xForIndex(bucket.centerIndex) - barWidth / 2;
      const h = (c.volume / maxVol) * 96;
      const color = c.close >= c.open ? theme.silver : visual.color;
      const alpha = (this.view.candleWidth < 0.8 ? 0.16 : c.close >= c.open ? 0.20 : 0.32) * Math.max(0.35, visual.alpha);
      g.rect(x, priceAreaBottom - h, barWidth, h).fill({ color, alpha });
    }
  }

  private volumeProfileCandleOverride(candle: Candle, index: number, data: Candle[], cachedAverageVolume?: number) {
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
    const averageVolume = cachedAverageVolume ?? this.cachedVolumeAverages(data, length)[index] ?? candle.volume;
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
    if (data.length === 0) {
      this.horizonRenderer.clear();
      return;
    }
    if (this.chartType === "horizon") {
      const transform = this.getPriceTransformSnapshot();
      this.horizonRenderer.draw({
        candles: data,
        firstIndex: this.view.firstIndex,
        lastIndex: this.view.lastIndex,
        pixelsPerCandle: this.timeStep(),
        plotTop: transform.plotTop,
        plotBottom: transform.plotBottom,
        xForIndex: (index) => this.xForIndex(index),
        yForPrice: (price) => this.yForPrice(price),
        settings: this.horizonSettings
      });
      return;
    }
    this.horizonRenderer.clear();
    if (this.chartType === "line") {
      this.drawLineSeries(g, data);
      return;
    }

    const stride = this.renderStride(1);
    const buckets = aggregateCandleRenderBuckets(data, this.view.firstIndex, this.view.lastIndex, stride);
    const settings = this.indicatorAdvancedSettings.volumeProfile;
    const volumeAverages = stride === 1 && this.visibleIndicators.volumeProfile && settings.volumeWeightedBarColoring
      ? this.cachedVolumeAverages(data, settings.volumeMaLength)
      : undefined;
    let previous = this.view.firstIndex > 0 ? data[this.view.firstIndex - 1] : undefined;
    for (const bucket of buckets) {
      const c = bucket.candle;
      const x = this.xForIndex(bucket.centerIndex);
      if (this.chartType === "renko") {
        this.drawRenkoBrick(g, c, x);
      } else if (this.chartType === "hollow") {
        this.drawHollowCandle(g, c, previous, x);
      } else if (this.chartType === "volumeFootprint") {
        this.drawClassicCandle(g, c, x, { color: c.close >= c.open ? theme.silver : theme.red, alpha: 0.28 });
      } else {
        const override = stride === 1
          ? this.volumeProfileCandleOverride(c, bucket.endIndex, data, volumeAverages?.[bucket.endIndex])
          : undefined;
        this.drawClassicCandle(g, c, x, override);
      }
      previous = c;
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

    for (const i of this.renderIndices(1)) {
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
    weight: "400" | "500" | "600" | "700" = "600",
    crisp = false
  ) {
    const item = new Text({
      text,
      ...(crisp ? {
        resolution: Math.min(3, Math.max(2, window.devicePixelRatio || 1)),
        roundPixels: true
      } : {}),
      style: {
        fontFamily: "IBM Plex Mono",
        fontSize: size,
        fill: color,
        fontWeight: weight
      }
    });
    item.x = crisp ? Math.round(x) : x;
    item.y = crisp ? Math.round(y) : y;
    this.profileTexts.push(item);
    this.indicatorLayer.addChild(item);
    return item;
  }

  private clearTexts() {
    this.countdownText = undefined;
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

      const priceText = last.close.toLocaleString(undefined, { maximumFractionDigits: 1 });
      const timerText = this.currentCandleCountdown();

      // Neon-glowing TradingView style box
      g.rect(plotWidth + 4, y - 18, 74, 36)
        .fill({ color: 0x07090b, alpha: 0.96 })
        .stroke({ width: 1.5, color: lineColor, alpha: 0.95 });

      this.countdownText = this.addText(
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
    if (!this.pointer.active || this.pointer.x < 0 || this.pointer.x > plotWidth || this.pointer.y < this.view.topPadding || this.pointer.y > plotHeight) {
      this.queueRender();
      return;
    }

    g.moveTo(this.pointer.x, this.view.topPadding)
      .lineTo(this.pointer.x, plotHeight)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.22 });
    g.moveTo(0, this.pointer.y)
      .lineTo(plotWidth, this.pointer.y)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.22 });

    g.circle(this.pointer.x, this.pointer.y, 3).fill({ color: theme.redBright, alpha: 0.9 });

    const ddaBounds = this.ddaProPaneBounds();
    const insideDdaPane = Boolean(ddaBounds && this.pointer.y >= ddaBounds.top && this.pointer.y <= ddaBounds.bottom);
    const acvdBounds = this.acvdPaneBounds();
    const insideAcvdPane = Boolean(acvdBounds && this.pointer.y >= acvdBounds.top && this.pointer.y <= acvdBounds.bottom);
    g.rect(plotWidth + 4, this.pointer.y - 11, 64, 22).fill({ color: theme.red, alpha: 0.95 });
    if (insideAcvdPane && acvdBounds) {
      const domain = this.acvdDomain();
      const ratio = Math.max(0, Math.min(1, (this.pointer.y - (acvdBounds.top + 18)) / Math.max(1, acvdBounds.height - 34)));
      const value = domain.max - ratio * domain.range;
      this.addCrosshairText(value.toFixed(1), plotWidth + 8, this.pointer.y - 7);
    } else if (insideDdaPane && ddaBounds) {
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

    if (this.chartType === "horizon") {
      const source = this.horizonRenderer.crosshair.resolve(
        this.horizonWaveEngine,
        this.getDisplayCandles(),
        this.horizonRenderer.currentProjection(),
        this.indexForX(this.pointer.x)
      );
      if (source) {
        const tooltipWidth = 282;
        const tooltipX = Math.max(8, Math.min(plotWidth - tooltipWidth - 8, this.pointer.x + 14));
        const tooltipY = Math.max(this.view.topPadding + 6, Math.min(plotHeight - 66, this.pointer.y + 12));
        const delta = Number.isFinite(source.candle.delta) ? source.candle.delta!.toFixed(4) : "--";
        const score = source.bucket?.directionScore;
        g.roundRect(tooltipX, tooltipY, tooltipWidth, 58, 4)
          .fill({ color: 0x030303, alpha: 0.97 })
          .stroke({ width: 1, color: score !== undefined && score < -0.075 ? theme.red : theme.silver, alpha: 0.68 });
        this.addCrosshairText(`BLACK HORIZON · TRUE 1S · ${new Date(source.candle.time * 1000).toISOString().slice(11, 19)} UTC`, tooltipX + 8, tooltipY + 6);
        this.addCrosshairText(`O ${source.candle.open.toFixed(2)}  H ${source.candle.high.toFixed(2)}  L ${source.candle.low.toFixed(2)}  C ${source.candle.close.toFixed(2)}`, tooltipX + 8, tooltipY + 21);
        this.addCrosshairText(`VOL ${source.candle.volume.toFixed(4)}  DELTA ${delta}  PRESSURE ${score === undefined ? "--" : score.toFixed(3)}`, tooltipX + 8, tooltipY + 36);
      }
    }

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
          const nearestTail = nearestDDAProTailLabel(ddaSnapshot.engineMode, ddaSnapshot.series, sourceIndex, depth);
          const tooltipX = Math.max(8, Math.min(plotWidth - 248, this.pointer.x + 14));
          const tooltipY = Math.max(paneTop + 5, Math.min(paneBottom - 91, this.pointer.y + 12));
          g.roundRect(tooltipX, tooltipY, 240, 87, 4)
            .fill({ color: 0x030305, alpha: 0.96 })
            .stroke({ width: 1, color: theme.red, alpha: 0.72 });
          this.addCrosshairText("BC-RDA " + (ddaSnapshot.series.riskState[sourceIndex] ?? "INSUFFICIENT") + " · RISK " + (ddaSnapshot.series.riskScore[sourceIndex] ?? 0).toFixed(1), tooltipX + 8, tooltipY + 6);
          this.addCrosshairText("DRAWDOWN " + (ddaSnapshot.series.rawDrawdown[sourceIndex] ?? 0).toFixed(2) + "% · DEPTH RANK " + (ddaSnapshot.series.percentileRank[sourceIndex] ?? 0).toFixed(1) + "%", tooltipX + 8, tooltipY + 21);
          this.addCrosshairText("DURATION " + (ddaSnapshot.series.duration[sourceIndex] ?? 0).toFixed(0) + " · VELOCITY " + (ddaSnapshot.series.velocity[sourceIndex] ?? 0).toFixed(3), tooltipX + 8, tooltipY + 36);
          this.addCrosshairText("VADD " + (ddaSnapshot.series.vadd[sourceIndex] ?? 0).toFixed(3) + " · NEAREST TAIL " + nearestTail, tooltipX + 8, tooltipY + 51);
          const flowState = ddaSnapshot.series.flowState[sourceIndex] ?? "UNAVAILABLE";
          const flowPressure = ddaSnapshot.series.flowPressure[sourceIndex];
          const flowCoverage = ddaSnapshot.series.flowCoveragePercent[sourceIndex] ?? 0;
          this.addCrosshairText("FLOW " + (flowState !== "UNAVAILABLE" && Number.isFinite(flowPressure) ? `${flowPressure! >= 0 ? "+" : ""}${flowPressure!.toFixed(1)}` : "--") + " " + flowState + " · COVERAGE " + flowCoverage.toFixed(0) + "%", tooltipX + 8, tooltipY + 66);
        }
      }
    }
    const acvdSnapshot = this.visibleIndicators.acvdOscillator ? this.acvdSnapshot : null;
    if (acvdSnapshot && acvdBounds && insideAcvdPane) {
      const chartIndex = this.indexForX(this.pointer.x);
      const sourceIndex = chartIndex - Math.max(0, this.getDisplayCandles().length - acvdSnapshot.inputSize);
      if (sourceIndex >= 0 && sourceIndex < acvdSnapshot.inputSize) {
        const pressure = acvdSnapshot.series.adaptivePressure[sourceIndex];
        const deltaRatio = acvdSnapshot.series.deltaRatio[sourceIndex];
        const coverage = acvdSnapshot.series.coveragePercent[sourceIndex];
        const regime = acvdSnapshot.series.regime[sourceIndex] ?? "UNAVAILABLE";
        const tooltipX = Math.max(8, Math.min(plotWidth - 250, this.pointer.x + 14));
        const certified = Number.isFinite(pressure) && Number.isFinite(deltaRatio) && Number.isFinite(coverage);
        const tooltipHeight = certified ? 69 : 42;
        const tooltipY = Math.max(acvdBounds.top + 5, Math.min(acvdBounds.bottom - tooltipHeight - 5, this.pointer.y + 12));
        g.roundRect(tooltipX, tooltipY, 242, tooltipHeight, 4)
          .fill({ color: 0x030305, alpha: 0.96 })
          .stroke({ width: 1, color: theme.red, alpha: certified ? 0.62 : 0.38 });
        if (!certified) {
          this.addCrosshairText("BC-ACVD · VERIFIED FLOW GAP", tooltipX + 8, tooltipY + 6);
          this.addCrosshairText("NO CERTIFIED AGGRESSOR FLOW FOR THIS BAR", tooltipX + 8, tooltipY + 21);
        } else {
          const finiteText = (value: number | undefined, digits: number) => Number.isFinite(value) ? value!.toFixed(digits) : "--";
          this.addCrosshairText(`BC-ACVD ${pressure!.toFixed(1)} · ${regime}`, tooltipX + 8, tooltipY + 6);
          this.addCrosshairText(`DELTA RATIO ${(deltaRatio! * 100).toFixed(2)}% · COVERAGE ${coverage!.toFixed(0)}%`, tooltipX + 8, tooltipY + 21);
          this.addCrosshairText(`CHOP ${finiteText(acvdSnapshot.series.chopProbability[sourceIndex], 0)} · DIVERGENCE ${finiteText(acvdSnapshot.series.divergenceScore[sourceIndex], 1)}`, tooltipX + 8, tooltipY + 36);
          this.addCrosshairText(`LONG ${finiteText(acvdSnapshot.series.longConfidence[sourceIndex], 0)} · SHORT ${finiteText(acvdSnapshot.series.shortConfidence[sourceIndex], 0)} · FINAL BARS`, tooltipX + 8, tooltipY + 51);
        }
      }
    }
    this.queueRender();
  }
}
