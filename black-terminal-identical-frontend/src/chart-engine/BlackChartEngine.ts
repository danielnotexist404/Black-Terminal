import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Text
} from "pixi.js";
import { CandleBuffer } from "./data/CandleBuffer";
import { LiquidationHeatmapModel } from "./heatmap/LiquidationHeatmapModel";
import { OrderBookHeatmapModel } from "./heatmap/OrderBookHeatmapModel";
import { VolatilityHeatmapModel } from "./heatmap/VolatilityHeatmapModel";
import { VolumeProfileModel, VolumeProfileResult, VolumeProfileRow } from "./profile/VolumeProfileModel";
import { defaultIndicatorAdvancedSettings } from "./profile/volumeProfileDefaults";
import type { IndicatorAlertDefinition } from "../automation/alerts";
import type { CompiledPlot } from "../components/ScriptCompiler";
import { OrderBookSnapshot } from "../market-data/types";
import { createAdaptiveSwingSignals } from "../modules/strategy-lab/adapters/signalAdapter";
import type { StrategySettings, StrategySignal } from "../modules/strategy-lab/types/strategy.types";
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
  background: 0x050607,
  grid: 0xffffff,
  gridAlpha: 0.032,
  text: 0xf1f2f4,
  muted: 0x8d929a,
  red: 0xd62839,
  redBright: 0xff303d,
  orange: 0xff6a00,
  orangeBright: 0xffb000,
  silver: 0xa7abb2,
  silverBright: 0xd9dce1,
  green: 0x46b866
};

const MIN_CANDLE_WIDTH = 0.18;
const MAX_CANDLE_WIDTH = 26;
const MIN_CANDLE_GAP = 0.04;
const MAX_CANDLE_GAP = 8;

type LiquidationHeatmapRow = {
  price: number;
  strength: number;
  longScore: number;
  shortScore: number;
};

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
  private candles: CandleBuffer;
  private displayedCandles: Candle[] = [];
  private heatmapModel = new LiquidationHeatmapModel();
  private orderBookHeatmapModel = new OrderBookHeatmapModel();
  private volatilityHeatmapModel = new VolatilityHeatmapModel();
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
  private onPriceChange?: (price: number) => void;
  private onCandleChange?: (candle: Candle) => void;
  private onNeedMoreHistory?: (oldestCandle: Candle) => void;
  private onFps?: (fps: number) => void;
  private onAlertEditRequest?: (alertId: string) => void;
  private activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDistance: number | null = null;
  private lastCountdownTime = 0;
  private customPlots: CompiledPlot[] = [];
  private alertDefinitions: IndicatorAlertDefinition[] = [];
  private visibleIndicators: VisibleIndicators = {
    orderBookHeatmap: false,
    liquidationHeatmap: false,
    volatilityHeatmap: false,
    volumeProfile: false,
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
    waveTrendOscillator: 10
  };
  private indicatorVisualSettings: IndicatorVisualSettings = {
    orderBookHeatmap: { color: "orange", intensity: 72 },
    liquidationHeatmap: { color: "red", intensity: 78 },
    volatilityHeatmap: { color: "green", intensity: 86 },
    volumeProfile: { color: "red", intensity: 72 },
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
    volume: { color: "red", intensity: 62 }
  };
  private indicatorAdvancedSettings: IndicatorAdvancedSettings = defaultIndicatorAdvancedSettings;

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
  private mockTimer?: number;
  private orderBookDrawTimer?: number;
  private lastOrderBookDrawAt = 0;
  private frameCount = 0;
  private lastFpsTime = performance.now();

  constructor(options: ChartEngineOptions) {
    this.host = options.host;
    this.candles = new CandleBuffer(options.candles);
    if (options.chartType) this.chartType = options.chartType;
    if (options.visibleIndicators) this.visibleIndicators = options.visibleIndicators;
    if (options.indicatorPeriods) this.indicatorPeriods = options.indicatorPeriods;
    if (options.indicatorVisualSettings) this.indicatorVisualSettings = options.indicatorVisualSettings;
    if (options.indicatorAdvancedSettings) this.indicatorAdvancedSettings = options.indicatorAdvancedSettings;
    this.setHeatmapSource(options.candles);
    this.onPriceChange = options.onPriceChange;
    this.onCandleChange = options.onCandleChange;
    this.onNeedMoreHistory = options.onNeedMoreHistory;
    this.onFps = options.onFps;
    this.alertDefinitions = options.alertDefinitions ?? [];
    this.onAlertEditRequest = options.onAlertEditRequest;
    if (options.priceLineColor !== undefined) this.priceLineColor = options.priceLineColor;
    if (options.priceLineIntensity !== undefined) this.priceLineIntensity = options.priceLineIntensity;
  }

  async init() {
    await this.app.init({
      background: theme.background,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      resizeTo: this.host,
      preference: "webgl",
      powerPreference: "high-performance"
    });

    this.host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.rootLayer);

    this.rootLayer.addChild(
      this.gridLayer,
      this.watermarkLayer,
      this.heatmapLayer,
      this.volumeLayer,
      this.candleLayer,
      this.indicatorLayer,
      this.drawingLayer,
      this.alertLayer,
      this.axisLayer,
      this.alertTextLayer,
      this.crosshairLayer
    );
    this.drawingLayer.addChild(this.drawingGraphics);

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;

    this.app.stage.on("pointermove", (e: FederatedPointerEvent) => {
      this.pointer = { x: e.global.x, y: e.global.y, active: true };
      this.setPriceScaleHover(this.isInsidePriceAxis(e.global.x, e.global.y));
      this.activePointers.set(e.pointerId, { x: e.global.x, y: e.global.y });

      if (this.activePointers.size === 2) {
        const coords = Array.from(this.activePointers.values());
        const dx = coords[0].x - coords[1].x;
        const dy = coords[0].y - coords[1].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (this.lastPinchDistance !== null && this.lastPinchDistance > 0) {
          const factor = dist / this.lastPinchDistance;
          const centerX = (coords[0].x + coords[1].x) / 2;
          this.zoomTimeAxis(factor, centerX);
          this.draw();
        }
        this.lastPinchDistance = dist;
        return;
      }

      if (this.handleDrawingPointerMove(e)) {
        return;
      } else if (this.priceScaleDragging) {
        this.scalePriceAxis(e.global.y);
      } else if (this.dragging) {
        const dx = e.global.x - this.dragStartX;
        const dy = e.global.y - this.dragStartY;
        const maxScroll = Math.max(0, (this.getDisplayCandles().length - 1) * this.timeStep());
        this.view.scrollX = Math.max(0, Math.min(maxScroll, this.dragStartScroll + dx));
        this.panPriceAxis(dy);
        this.draw();
      } else {
        this.drawCrosshair();
      }
    });

    this.app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
      this.activePointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
      if (this.activePointers.size === 2) {
        this.dragging = false;
        const coords = Array.from(this.activePointers.values());
        const dx = coords[0].x - coords[1].x;
        const dy = coords[0].y - coords[1].y;
        this.lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
        return;
      }

      if (e.button !== 0) return;

      if (this.handleReplaySelectionPointerDown(e)) return;

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
      this.setPriceScaleHover(false);
      this.finishBrushDrawing();
      this.stopDragging();
      this.drawCrosshair();
    });

    this.host.addEventListener("wheel", this.onWheel, { passive: false });
    this.host.addEventListener("dblclick", this.onDoubleClick);
    this.host.addEventListener("contextmenu", this.onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this.queueResize());
    this.resizeObserver.observe(this.host);
    window.addEventListener("black-terminal-layout-resize", this.queueResize);

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

  getScreenYForPrice(price: number) {
    if (!Number.isFinite(price)) return null;
    return this.yForPrice(price);
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

  ingestOrderBookSnapshot(snapshot: OrderBookSnapshot) {
    this.orderBookHeatmapModel.ingest(snapshot);
    if (!this.visibleIndicators.orderBookHeatmap) return;

    const now = performance.now();
    const waitMs = 260 - (now - this.lastOrderBookDrawAt);
    if (waitMs <= 0) {
      this.lastOrderBookDrawAt = now;
      this.draw();
      return;
    }

    if (this.orderBookDrawTimer) return;
    this.orderBookDrawTimer = window.setTimeout(() => {
      this.orderBookDrawTimer = undefined;
      this.lastOrderBookDrawAt = performance.now();
      this.draw();
    }, waitMs);
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
    if (!this.visibleIndicators.orderBookHeatmap && this.orderBookDrawTimer) {
      window.clearTimeout(this.orderBookDrawTimer);
      this.orderBookDrawTimer = undefined;
    }
    this.setHeatmapSource(this.candles.all(), this.heatmapVisibleUntilIndex);
    this.draw();
  }

  setPriceLineSettings(color: string, intensity: number) {
    this.priceLineColor = color;
    this.priceLineIntensity = intensity;
    this.draw();
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
    if (this.visibleIndicators.liquidationHeatmap) {
      this.heatmapModel.setSource(candles);
    }
    if (this.visibleIndicators.orderBookHeatmap) {
      this.orderBookHeatmapModel.setCandles(candles);
    }
    if (this.visibleIndicators.volatilityHeatmap) {
      this.volatilityHeatmapModel.setSource(candles, this.indicatorPeriods.volatilityHeatmap);
    }
  }

  destroy() {
    if (this.mockTimer) window.clearInterval(this.mockTimer);
    this.host.removeEventListener("wheel", this.onWheel);
    this.host.removeEventListener("dblclick", this.onDoubleClick);
    this.host.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("black-terminal-layout-resize", this.queueResize);
    if (this.resizeRaf) window.cancelAnimationFrame(this.resizeRaf);
    if (this.orderBookDrawTimer) window.clearTimeout(this.orderBookDrawTimer);
    this.host.classList.remove("price-scale-dragging", "price-scale-hover", "drawing-eraser");
    this.setReplaySelectionMode(false);
    this.resizeObserver?.disconnect();
    this.clearDrawingTexts();
    this.clearAlertTexts();
    this.clearProfileTexts();
    this.clearHeatmapTexts();
    this.app.destroy(true, { children: true, texture: true });
  }

  private stopDragging() {
    this.dragging = false;
    this.priceScaleDragging = false;
    this.host.classList.remove("price-scale-dragging");
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
    const startRange = this.priceScaleDragStartMax - this.priceScaleDragStartMin;
    const center = (this.priceScaleDragStartMax + this.priceScaleDragStartMin) / 2;
    const factor = Math.max(0.08, Math.min(16, Math.exp((y - this.priceScaleDragStartY) * 0.006)));
    const halfRange = (startRange * factor) / 2;

    this.manualPriceRange = {
      min: center - halfRange,
      max: center + halfRange
    };
    this.draw();
  }

  private panPriceAxis(dy: number) {
    if (Math.abs(dy) < 1) return;
    const plotHeight = Math.max(1, this.view.height - this.view.bottomAxisHeight - this.view.topPadding);
    const startRange = this.dragStartPriceMax - this.dragStartPriceMin;
    const priceDelta = (dy / plotHeight) * startRange;

    this.manualPriceRange = {
      min: this.dragStartPriceMin + priceDelta,
      max: this.dragStartPriceMax + priceDelta
    };
  }

  private onDoubleClick = (e: MouseEvent) => {
    const bounds = this.host.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    const alertHit = this.hitPriceAlertLine(x, y);
    if (alertHit) {
      e.preventDefault();
      this.onAlertEditRequest?.(alertHit.id);
      return;
    }

    if (!this.isInsidePriceAxis(x, y)) return;

    this.manualPriceRange = undefined;
    this.draw();
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();

    const bounds = this.host.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const mostlyHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.7;

    if (e.shiftKey || (!e.ctrlKey && mostlyHorizontal)) {
      this.panTimeAxis(e.deltaX + e.deltaY);
    } else {
      const zoomIntensity = e.ctrlKey ? 0.0022 : 0.0017;
      const factor = Math.exp(-e.deltaY * zoomIntensity);
      this.zoomTimeAxis(factor, x);
    }

    this.draw();
  };

  private panTimeAxis(delta: number) {
    const maxScroll = Math.max(0, (this.getDisplayCandles().length - 1) * this.timeStep());
    this.view.scrollX = Math.max(0, Math.min(maxScroll, this.view.scrollX + delta * 0.9));
  }

  private zoomTimeAxis(factor: number, anchorX: number) {
    const data = this.getDisplayCandles();
    if (data.length === 0 || !Number.isFinite(factor) || factor <= 0) return;

    const oldStep = this.timeStep();
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const clampedX = Math.max(0, Math.min(plotWidth, anchorX));
    const barsFromRight = (plotWidth - this.view.candleWidth / 2 - 12 - clampedX) / oldStep;
    const anchorIndex = this.view.lastIndex - barsFromRight;

    this.view.candleWidth = Math.max(MIN_CANDLE_WIDTH, Math.min(MAX_CANDLE_WIDTH, this.view.candleWidth * factor));
    this.view.gap = Math.max(
      MIN_CANDLE_GAP,
      Math.min(MAX_CANDLE_GAP, this.view.candleWidth < 1.4 ? this.view.candleWidth * 0.22 : this.view.candleWidth * 0.38)
    );

    const newStep = this.timeStep();
    const nextBarsFromRight = (plotWidth - this.view.candleWidth / 2 - 12 - clampedX) / newStep;
    const desiredLastIndex = anchorIndex + nextBarsFromRight;
    const maxScroll = Math.max(0, (data.length - 1) * newStep);
    this.view.scrollX = Math.max(0, Math.min(maxScroll, (data.length - 1 - desiredLastIndex) * newStep));
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
    if (now - this.lastFpsTime > 500) {
      const fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
      this.onFps?.(fps);
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
    const lastIndex = Math.max(0, data.length - 1 - Math.floor(this.view.scrollX / step));
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
    const barsFromRight = this.view.lastIndex - index;
    return plotWidth - barsFromRight * step - this.view.candleWidth / 2 - 12;
  }

  private getOscillatorPaneHeight() {
    const hasOscillator =
      this.visibleIndicators.openInterestOscillator ||
      this.visibleIndicators.zScoreOscillator ||
      this.visibleIndicators.waveTrendOscillator;
    if (!hasOscillator) return 0;

    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const paneHeight = Math.max(82, Math.min(128, plotHeight * 0.19));
    return paneHeight + 20;
  }

  private yForPrice(price: number) {
    const oscHeight = this.getOscillatorPaneHeight();
    const plotHeight = this.view.height - this.view.bottomAxisHeight - this.view.topPadding - oscHeight;
    const n = (price - this.view.priceMin) / (this.view.priceMax - this.view.priceMin);
    return this.view.topPadding + (1 - n) * plotHeight;
  }

  private priceForY(y: number) {
    const oscHeight = this.getOscillatorPaneHeight();
    const plotHeight = this.view.height - this.view.bottomAxisHeight - this.view.topPadding - oscHeight;
    const n = 1 - (y - this.view.topPadding) / plotHeight;
    return this.view.priceMin + n * (this.view.priceMax - this.view.priceMin);
  }

  private indexForX(x: number) {
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const barsFromRight = (plotWidth - this.view.candleWidth / 2 - 12 - x) / this.timeStep();
    return Math.max(0, Math.min(this.getDisplayCandles().length - 1, Math.round(this.view.lastIndex - barsFromRight)));
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
  }

  private drawGrid() {
    const g = this.gridLayer;
    g.clear();
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;

    g.rect(0, 0, this.view.width, this.view.height).fill({ color: theme.background });

    for (let i = 0; i <= 8; i++) {
      const y = this.view.topPadding + ((plotHeight - this.view.topPadding) / 8) * i;
      g.moveTo(0, y).lineTo(plotWidth, y).stroke({ width: 1, color: theme.grid, alpha: theme.gridAlpha });
    }

    const data = this.getDisplayCandles();
    const ticks = this.getAlignedTimeTicks(data);
    for (const tick of ticks) {
      g.moveTo(tick.x, this.view.topPadding).lineTo(tick.x, plotHeight).stroke({ width: 1, color: theme.grid, alpha: theme.gridAlpha });
    }

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
    if (
      !this.visibleIndicators.orderBookHeatmap &&
      !this.visibleIndicators.liquidationHeatmap &&
      !this.visibleIndicators.volatilityHeatmap
    ) {
      return;
    }

    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    this.drawVolatilityHeatmap(g, plotWidth, plotHeight);
    this.drawOrderBookHeatmap(g, plotWidth, plotHeight);

    if (!this.visibleIndicators.liquidationHeatmap) return;

    const visual = this.visualFor("liquidationHeatmap", "red");
    const untilIndex = this.heatmapVisibleUntilIndex ?? this.candles.all().length - 1;
    const cells = this.heatmapModel.visibleCells(
      this.view.firstIndex,
      this.view.lastIndex,
      untilIndex,
      this.view.priceMin,
      this.view.priceMax
    );
    const step = this.timeStep();
    const profile = new Map<string, { price: number; strength: number }>();

    for (const cell of cells) {
      const startIndex = Math.max(this.view.firstIndex, cell.startIndex);
      const endIndex = Math.min(this.view.lastIndex, untilIndex, cell.endIndex);
      if (endIndex < startIndex) continue;

      const x1 = this.xForIndex(startIndex) - step * 0.5;
      const x2 = this.xForIndex(endIndex) + step * 0.5;
      if (x2 < 0 || x1 > plotWidth) continue;

      const yTop = this.yForPrice(cell.priceHigh);
      const yBottom = this.yForPrice(cell.priceLow);
      const y = Math.min(yTop, yBottom);
      const h = Math.max(1.1, Math.abs(yBottom - yTop));
      if (y + h < this.view.topPadding || y > plotHeight) continue;

      const color = this.liquidationColor(cell.strength);
      const alpha = (0.032 + cell.strength * 0.22) * Math.max(0.35, visual.alpha);
      g.rect(Math.max(0, x1), y, Math.min(plotWidth, x2) - Math.max(0, x1), h)
        .fill({ color, alpha });

      if (cell.strength >= 0.55) {
        const coreHeight = Math.max(1, h * 0.42);
        g.rect(Math.max(0, x1), y + h * 0.29, Math.min(plotWidth, x2) - Math.max(0, x1), coreHeight)
          .fill({ color, alpha: Math.min(0.48, alpha + 0.075) });
      }

      const profileKey = String(Math.round(cell.price / Math.max(1, (this.view.priceMax - this.view.priceMin) / 180)));
      const current = profile.get(profileKey);
      if (!current || cell.strength > current.strength) {
        profile.set(profileKey, { price: cell.price, strength: cell.strength });
      }
    }

    const profileLevels = [...profile.values()]
      .filter((level) => level.strength >= 0.15)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 80);

    for (const lvl of profileLevels) {
      const y = this.yForPrice(lvl.price);
      if (y < this.view.topPadding || y > plotHeight) continue;
      const color = this.liquidationColor(lvl.strength);
      const width = plotWidth * (0.08 + lvl.strength * 0.28);
      const height = 1.2 + lvl.strength * 2.8;
      g.rect(plotWidth - width - 16, y - height / 2, width, height)
        .fill({ color, alpha: (0.08 + lvl.strength * 0.18) * Math.max(0.35, visual.alpha) });
    }

    for (const lvl of this.liquidityLevels()) {
      const y = this.yForPrice(lvl.price);
      if (y < this.view.topPadding || y > plotHeight) continue;
      const width = plotWidth * (0.20 + lvl.strength * 0.42);
      const x = plotWidth - width - 18;
      const h = 7 + lvl.strength * 12;
      g.rect(x, y - h / 2, width, h).fill({ color: lvl.color, alpha: (lvl.color === theme.orangeBright ? 0.36 : 0.24) * Math.max(0.35, visual.alpha) });
      for (let k = 0; k < 8; k++) {
        const bw = width * this.profileBandScale(lvl.strength, k);
        g.rect(plotWidth - bw - 18, y - h / 2 + k * 2.2, bw, 1.05)
          .fill({ color: lvl.color, alpha: (lvl.color === theme.orangeBright ? 0.24 : 0.15) * Math.max(0.35, visual.alpha) });
      }
    }
  }

  private drawVolatilityHeatmap(g: Graphics, plotWidth: number, plotHeight: number) {
    if (!this.visibleIndicators.volatilityHeatmap) return;

    const visual = this.visualFor("volatilityHeatmap", "red");
    const untilIndex = this.heatmapVisibleUntilIndex ?? this.candles.all().length - 1;
    const cells = this.volatilityHeatmapModel.visibleCells(
      this.view.firstIndex,
      this.view.lastIndex,
      untilIndex,
      this.view.priceMin,
      this.view.priceMax
    );
    if (cells.length === 0) return;

    const step = this.timeStep();
    const xClamp = (value: number) => Math.max(0, Math.min(plotWidth, value));
    const drawableCells = [...cells]
      .filter((cell) => cell.strength >= 0.08)
      .sort((a, b) => a.strength - b.strength);
    const labelCells = [...cells]
      .filter((cell) => cell.hot)
      .sort((a, b) => Math.abs(b.volume) - Math.abs(a.volume))
      .slice(0, 60);

    for (const cell of drawableCells) {
      const startIndex = Math.max(0, cell.startIndex);
      const endIndex = Math.min(untilIndex, cell.endIndex);
      if (endIndex < startIndex) continue;

      const x1 = xClamp(this.xForIndex(startIndex) - step * 0.5);
      const x2 = plotWidth;
      const w = x2 - x1;
      if (w <= 0.7) continue;

      const yMid = this.yForPrice(cell.price);
      const yTop = this.yForPrice(cell.priceHigh);
      const yBottom = this.yForPrice(cell.priceLow);
      const rawHeight = Math.max(1, Math.abs(yBottom - yTop));
      const h = Math.max(1.2, Math.min(6.5, rawHeight));
      const y = yMid - h / 2;
      if (y + h < this.view.topPadding || y > plotHeight) continue;

      const alphaScale = Math.max(0.35, visual.alpha);
      const color = cell.hot ? theme.redBright : 0x8b9097;
      const fillColor = cell.hot ? 0x2a0308 : 0x111417;
      const lineAlpha = cell.hot
        ? Math.min(0.86, (0.42 + cell.strength * 0.32) * alphaScale)
        : Math.min(0.36, (0.09 + cell.strength * 0.18) * alphaScale);

      g.rect(x1, y, w, h)
        .fill({ color: fillColor, alpha: cell.hot ? 0.12 * alphaScale : 0.035 * alphaScale });

      const coreY = Math.max(this.view.topPadding, Math.min(plotHeight, yMid));
      g.moveTo(x1, coreY).lineTo(x2, coreY)
        .stroke({ width: cell.hot ? 1.25 + cell.strength * 1.15 : 0.55, color, alpha: lineAlpha });

      if (cell.hot) {
        g.moveTo(x1, coreY - 2.8).lineTo(x2, coreY - 2.8)
          .stroke({ width: 0.75, color: theme.redBright, alpha: Math.min(0.36, lineAlpha * 0.55) });
        g.moveTo(x1, coreY + 2.8).lineTo(x2, coreY + 2.8)
          .stroke({ width: 0.75, color: theme.redBright, alpha: Math.min(0.36, lineAlpha * 0.55) });
      }
    }

    const placedY: number[] = [];
    for (const cell of labelCells) {
      const y = this.yForPrice(cell.price);
      if (y < this.view.topPadding || y > plotHeight) continue;
      if (placedY.some((item) => Math.abs(item - y) < 8)) continue;
      placedY.push(y);
      this.addHeatmapText(this.compactVolume(Math.abs(cell.volume)), plotWidth - 58, y - 5, 0xffffff, 8);
    }
  }

  private drawVolatilityLadderCell(
    g: Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    strength: number,
    side: "support" | "resistance",
    selectedColor: number,
    visualAlpha: number
  ) {
    const boundedY = Math.max(this.view.topPadding, y);
    const boundedH = Math.min(this.view.height - this.view.bottomAxisHeight, y + h) - boundedY;
    if (boundedH <= 0 || w <= 0) return;

    const alphaScale = Math.max(0.35, visualAlpha);
    const rowGap = side === "support"
      ? Math.max(4.2, Math.min(8.2, 8.0 - strength * 2.4))
      : Math.max(4.8, Math.min(9.5, 9.2 - strength * 2.8));
    const rows = Math.max(2, Math.min(28, Math.floor(boundedH / rowGap)));
    const rowAlpha = side === "resistance"
      ? (0.045 + strength * 0.18) * alphaScale
      : (0.14 + strength * 0.28) * alphaScale;

    if (side === "resistance") {
      const baseColor = strength > 0.84 ? theme.orangeBright : strength > 0.68 ? theme.redBright : selectedColor;
      g.rect(x, boundedY, w, boundedH)
        .fill({ color: 0x170306, alpha: Math.min(0.13, (0.012 + strength * 0.045) * alphaScale) });

      for (let row = 0; row <= rows; row++) {
        const p = rows === 0 ? 0.5 : row / rows;
        const yy = boundedY + p * boundedH;
        const taper = 0.78 + Math.sin((p * Math.PI) || 0) * 0.22;
        const lineWidth = w * taper;
        const x2 = x + lineWidth;
        g.moveTo(x, yy).lineTo(x2, yy)
          .stroke({ width: strength > 0.72 ? 1.05 : 0.7, color: baseColor, alpha: Math.min(0.36, rowAlpha) });
      }

      const coreY = boundedY + boundedH * (0.48 + Math.sin(strength * 5.2) * 0.04);
      g.rect(x, coreY - 1, w, 2)
        .fill({ color: baseColor, alpha: Math.min(0.62, (0.18 + strength * 0.34) * alphaScale) });
      if (strength >= 0.82) {
        g.rect(x, coreY - 3.4, w, 6.8)
          .fill({ color: theme.orangeBright, alpha: Math.min(0.15, 0.05 + strength * 0.07) * alphaScale });
      }
      return;
    }

    g.rect(x, boundedY, w, boundedH)
      .fill({ color: 0x010203, alpha: Math.min(0.82, (0.46 + strength * 0.34) * alphaScale) });
    g.rect(x, boundedY, w, boundedH)
      .stroke({ width: 0.85, color: 0x6f7781, alpha: Math.min(0.34, (0.14 + strength * 0.18) * alphaScale) });

    for (let row = 0; row <= rows; row++) {
      const p = rows === 0 ? 0.5 : row / rows;
      const yy = boundedY + p * boundedH;
      const notch = 0.88 + Math.cos(p * Math.PI * 2.2 + strength) * 0.07;
      const lineWidth = w * notch;
      g.moveTo(x, yy).lineTo(x + lineWidth, yy)
        .stroke({ width: strength > 0.7 ? 0.95 : 0.75, color: 0x8a929d, alpha: Math.min(0.46, rowAlpha) });
    }

    const voidY = boundedY + boundedH * 0.5;
    g.rect(x, voidY - Math.max(1.4, boundedH * 0.035), w, Math.max(2.4, boundedH * 0.07))
      .fill({ color: 0x000000, alpha: Math.min(0.96, (0.64 + strength * 0.26) * alphaScale) });

    if (strength >= 0.76) {
      g.moveTo(x, voidY).lineTo(x + w, voidY)
        .stroke({ width: 1.15, color: theme.silverBright, alpha: Math.min(0.46, 0.18 + strength * 0.24) * alphaScale });
      g.moveTo(x, boundedY + boundedH * 0.18).lineTo(x + w, boundedY + boundedH * 0.18)
        .stroke({ width: 0.85, color: theme.green, alpha: Math.min(0.28, 0.08 + strength * 0.14) * alphaScale });
    }
  }

  private drawOrderBookHeatmap(g: Graphics, plotWidth: number, plotHeight: number) {
    if (!this.visibleIndicators.orderBookHeatmap) return;

    const visual = this.visualFor("orderBookHeatmap", "orange");
    const cells = this.orderBookHeatmapModel.cells(
      this.view.firstIndex,
      this.view.lastIndex,
      this.view.priceMin,
      this.view.priceMax
    );
    if (cells.length === 0) return;

    for (const cell of cells) {
      if (cell.strength < 0.018) continue;

      const x1 = this.xForIndex(cell.xStartIndex);
      const x2 = this.xForIndex(cell.xEndIndex);
      const x = Math.max(0, Math.min(x1, x2));
      const w = Math.min(plotWidth, Math.max(x1, x2)) - x;
      if (w <= 0.4 || x > plotWidth) continue;

      const yTop = this.yForPrice(cell.priceHigh);
      const yBottom = this.yForPrice(cell.priceLow);
      const y = Math.min(yTop, yBottom);
      const h = Math.max(1, Math.min(4.5, Math.abs(yBottom - yTop)));
      if (y + h < this.view.topPadding || y > plotHeight) continue;

      const color = this.orderBookHeatmapColor(cell.strength, cell.side);
      const alpha = (0.028 + cell.strength * 0.34) * Math.max(0.35, visual.alpha);

      g.rect(x, y, w, h).fill({ color, alpha: Math.min(0.72, alpha) });
      if (cell.strength > 0.72) {
        g.rect(x, y + h * 0.35, w, Math.max(0.7, h * 0.3))
          .fill({ color: theme.orangeBright, alpha: Math.min(0.48, alpha * 0.8) });
      }
    }
  }

  private orderBookHeatmapColor(strength: number, side: "bid" | "ask") {
    if (strength >= 0.88) return 0xfff05a;
    if (strength >= 0.70) return theme.orangeBright;
    if (strength >= 0.48) return side === "bid" ? 0xd1a315 : theme.redBright;
    if (strength >= 0.22) return side === "bid" ? theme.orange : theme.red;
    return side === "bid" ? 0x6f3a22 : 0x651927;
  }

  private liquidationColor(strength: number) {
    if (strength >= 0.86) return theme.orangeBright;
    if (strength >= 0.68) return theme.orange;
    if (strength >= 0.44) return theme.redBright;
    return theme.red;
  }

  private liquidationHeatmapRows(rowCount: number): LiquidationHeatmapRow[] {
    const source = this.candles.all().slice(-900);
    const last = source[source.length - 1];
    const range = Math.max(1, this.view.priceMax - this.view.priceMin);
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      price: this.view.priceMin + (range * index) / Math.max(1, rowCount - 1),
      score: 0,
      longScore: 0,
      shortScore: 0
    }));

    if (!last || source.length < 12) {
      return rows.map((row) => ({ ...row, strength: 0 }));
    }

    const maxVol = Math.max(...source.map((candle) => candle.volume), 1);
    const current = last.close;
    const visibleMin = this.view.priceMin - range * 0.12;
    const visibleMax = this.view.priceMax + range * 0.12;
    const leverageTiers = [
      { leverage: 5, weight: 0.42 },
      { leverage: 10, weight: 0.66 },
      { leverage: 25, weight: 0.98 },
      { leverage: 50, weight: 1.14 },
      { leverage: 100, weight: 0.86 }
    ];

    const addLevel = (price: number, score: number, side: "long" | "short") => {
      if (price < visibleMin || price > visibleMax || !Number.isFinite(price)) return;
      const index = Math.round(((price - this.view.priceMin) / range) * (rowCount - 1));

      for (let offset = -4; offset <= 4; offset++) {
        const target = index + offset;
        const row = rows[target];
        if (!row) continue;
        const gaussian = Math.exp(-(offset * offset) / 6.2);
        const weighted = score * gaussian;
        row.score += weighted;
        if (side === "long") row.longScore += weighted;
        else row.shortScore += weighted;
      }
    };

    for (const candle of source) {
      const span = Math.max(candle.high - candle.low, range * 0.002);
      const bodyPressure = Math.min(1, Math.abs(candle.close - candle.open) / span);
      const volWeight = Math.sqrt(candle.volume / maxVol) * (0.58 + bodyPressure * 0.72);
      const references = [
        { price: candle.close, weight: 1 },
        { price: candle.open, weight: 0.62 },
        { price: candle.high, weight: 0.34 },
        { price: candle.low, weight: 0.34 }
      ];

      for (const reference of references) {
        for (const tier of leverageTiers) {
          const liquidationDistance = 0.92 / tier.leverage;
          const proximityBoost = 1 + Math.exp(-Math.abs(reference.price - current) / (range * 0.42)) * 0.65;
          const score = reference.weight * tier.weight * volWeight * proximityBoost;
          addLevel(reference.price * (1 + liquidationDistance), score, "short");
          addLevel(reference.price * (1 - liquidationDistance), score, "long");
        }
      }
    }

    for (let i = 2; i < source.length - 2; i++) {
      const candle = source[i];
      const prevA = source[i - 1];
      const prevB = source[i - 2];
      const nextA = source[i + 1];
      const nextB = source[i + 2];
      const swingHigh = candle.high >= prevA.high && candle.high >= prevB.high && candle.high >= nextA.high && candle.high >= nextB.high;
      const swingLow = candle.low <= prevA.low && candle.low <= prevB.low && candle.low <= nextA.low && candle.low <= nextB.low;
      const swingWeight = Math.sqrt(candle.volume / maxVol) * 4.2;

      if (swingHigh) {
        addLevel(candle.high * 1.018, swingWeight, "short");
        addLevel(candle.high * 1.036, swingWeight * 0.68, "short");
      }
      if (swingLow) {
        addLevel(candle.low * 0.982, swingWeight, "long");
        addLevel(candle.low * 0.964, swingWeight * 0.68, "long");
      }
    }

    const maxScore = Math.max(...rows.map((row) => row.score), 1);
    return rows.map((row) => ({
      price: row.price,
      strength: Math.min(1, Math.pow(row.score / maxScore, 0.72)),
      longScore: row.longScore,
      shortScore: row.shortScore
    }));
  }

  private liquidityLevels() {
    if (!this.visibleIndicators.liquidationHeatmap) return [];

    const untilIndex = this.heatmapVisibleUntilIndex ?? this.candles.all().length - 1;
    const candidates = this.heatmapModel.liquidityLevels(
      untilIndex,
      this.view.priceMin,
      this.view.priceMax,
      6
    );

    const selected: Array<{
      price: number;
      strength: number;
      color: number;
      label: string;
      labelColor: number;
    }> = [];
    for (const candidate of candidates) {
      const side = candidate.side === "short" ? "Short" : "Long";
      const strongest = candidate.strength >= 0.86;
      const color = this.liquidationColor(candidate.strength);
      selected.push({
        price: candidate.price,
        strength: candidate.strength,
        color,
        label: strongest ? "Max Liq" : `${side} Liq`,
        labelColor: strongest ? theme.orangeBright : theme.redBright
      });
      if (selected.length >= 5) break;
    }

    return selected;
  }

  private resolvedLiquidityLabelPositions(plotHeight: number) {
    const minY = this.view.topPadding + 12;
    const maxY = plotHeight - 16;
    const levels = this.liquidityLevels()
      .map((level) => ({
        ...level,
        y: Math.max(minY, Math.min(maxY, this.yForPrice(level.price)))
      }))
      .sort((a, b) => a.y - b.y);

    for (let i = 1; i < levels.length; i++) {
      if (levels[i].y - levels[i - 1].y < 18) {
        levels[i].y = levels[i - 1].y + 18;
      }
    }

    const overflow = levels.length ? levels[levels.length - 1].y - maxY : 0;
    if (overflow > 0) {
      for (const level of levels) {
        level.y = Math.max(minY, level.y - overflow);
      }
    }

    return levels;
  }

  private profileBandScale(strength: number, index: number) {
    const seed = (Math.round(strength * 100) + index * 37) % 82;
    return 0.18 + seed / 100;
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
    const out: number[] = [];
    let cumulativePriceVolume = 0;
    let cumulativeVolume = 0;
    const startIndex = Math.max(0, Math.min(this.view.firstIndex, data.length - 1));

    for (let i = 0; i < data.length; i++) {
      const candle = data[i];
      if (!candle) {
        out.push(Number.NaN);
        continue;
      }

      if (i < startIndex) {
        out.push(Number.NaN);
        continue;
      }

      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePriceVolume += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
      out.push(cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : typicalPrice);
    }

    return out;
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
    const closes = data.map((candle) => candle.close);
    return closes.map((close, index) => {
      const slice = closes.slice(Math.max(0, index - period + 1), index + 1);
      const mean = slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
      const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, slice.length);
      const deviation = Math.sqrt(variance);
      return deviation > 0 ? Math.max(-5, Math.min(5, (close - mean) / deviation)) * 24 : 0;
    });
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

  private drawOscillatorPane(data: Candle[]) {
    const hasOscillator =
      this.visibleIndicators.openInterestOscillator ||
      this.visibleIndicators.zScoreOscillator ||
      this.visibleIndicators.waveTrendOscillator;
    if (!hasOscillator) return;

    const g = this.indicatorLayer;
    const plotWidth = this.view.width - this.view.rightAxisWidth;
    const plotHeight = this.view.height - this.view.bottomAxisHeight;
    const paneBottom = plotHeight - 16;
    const paneHeight = Math.max(82, Math.min(128, plotHeight * 0.19));
    const paneTop = Math.max(this.view.topPadding + 22, paneBottom - paneHeight);
    const paneMid = (paneTop + paneBottom) / 2;
    const paneHalf = Math.max(1, (paneBottom - paneTop) / 2);

    g.rect(0, paneTop, plotWidth, paneBottom - paneTop)
      .fill({ color: 0x020304, alpha: 0.58 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.055 });
    g.moveTo(0, paneMid).lineTo(plotWidth, paneMid).stroke({ width: 1, color: theme.silverBright, alpha: 0.18 });
    g.moveTo(0, paneTop + paneHalf * 0.5).lineTo(plotWidth, paneTop + paneHalf * 0.5).stroke({ width: 1, color: theme.red, alpha: 0.10 });
    g.moveTo(0, paneBottom - paneHalf * 0.5).lineTo(plotWidth, paneBottom - paneHalf * 0.5).stroke({ width: 1, color: theme.red, alpha: 0.10 });

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

    const visibleValues = series.flatMap((item) =>
      item.values.slice(this.view.firstIndex, this.view.lastIndex + 1).map((value) => Math.abs(value))
    );
    const maxAbs = Math.max(60, Math.min(180, Math.max(...visibleValues, 1) * 1.16));
    const yForOsc = (value: number) => paneMid - (Math.max(-maxAbs, Math.min(maxAbs, value)) / maxAbs) * paneHalf * 0.88;

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
        g.stroke({
          width: item.dashed ? 1 : 1.35,
          color: visual.color,
          alpha: item.dashed ? visual.alpha * 0.42 : visual.alpha * 0.78
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

    const rangeLength = Math.max(10, Math.min(5000, Math.round(settings.fixedRangeLength)));
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
    for (const row of rows) {
      if (!row.supplyDemand) continue;
      const yHigh = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceHigh)));
      const yLow = Math.max(this.view.topPadding, Math.min(plotHeight, this.yForPrice(row.priceLow)));
      const y = Math.min(yHigh, yLow);
      const height = Math.max(1, Math.abs(yLow - yHigh));
      const color = row.supplyDemand === "supply"
        ? this.hexColor(this.indicatorAdvancedSettings.volumeProfile.supplyZoneColor, theme.redBright)
        : this.hexColor(this.indicatorAdvancedSettings.volumeProfile.demandZoneColor, 0x0094ff);
      g.rect(leftX, y, Math.max(1, rightX - leftX), height).fill({ color, alpha: row.supplyDemand === "supply" ? 0.035 : 0.028 });
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

    const vwapLine = () => {
      let started = false;
      let cumulativePriceVolume = 0;
      let cumulativeVolume = 0;
      for (let i = this.view.firstIndex; i <= this.view.lastIndex; i++) {
        const candle = data[i];
        if (!candle) continue;
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        cumulativePriceVolume += typicalPrice * candle.volume;
        cumulativeVolume += candle.volume;
        const vwap = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : typicalPrice;
        const x = this.xForIndex(i);
        const y = this.yForPrice(vwap);
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else {
          g.lineTo(x, y);
        }
      }
      const visual = this.visualFor("vwap", "gray");
      g.stroke({ width: 1, color: visual.color, alpha: visual.alpha * 0.66 });
    };

    if (this.visibleIndicators.bollinger) bollingerBands(this.indicatorPeriods.bollinger);
    if (this.visibleIndicators.vwap) vwapLine();
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

    this.drawOscillatorPane(data);
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
    const visible = data.slice(this.view.firstIndex, this.view.lastIndex + 1);
    const maxVol = Math.max(...visible.map(c => c.volume), 1);

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
        this.drawFootprintCandle(g, c, x, maxVol);
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
    const color = override?.color ?? (bullish ? theme.silver : theme.red);
    const wick = override?.wick ?? (bullish ? theme.silverBright : theme.redBright);
    const alpha = override?.alpha ?? 0.98;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(openY - closeY));

    if (this.view.candleWidth < 1.2) {
      const wickWidth = Math.max(0.35, Math.min(0.85, this.view.candleWidth * 1.7));
      const bodyWidth = Math.max(0.55, Math.min(1.15, this.view.candleWidth * 2.6));
      g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: wickWidth, color: wick, alpha: 0.54 });
      g.moveTo(x, openY).lineTo(x, closeY).stroke({ width: bodyWidth, color, alpha: alpha * 0.92 });
      return;
    }

    const bodyWidth = Math.max(1, this.view.candleWidth);
    g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: 1.15, color: wick, alpha: 0.95 });
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

  private drawFootprintCandle(g: Graphics, c: Candle, x: number, maxVol: number) {
    if (this.view.candleWidth < 3.2) {
      this.drawClassicCandle(g, c, x);
      return;
    }

    const openY = this.yForPrice(c.open);
    const closeY = this.yForPrice(c.close);
    const highY = this.yForPrice(c.high);
    const lowY = this.yForPrice(c.low);
    const bullish = c.close >= c.open;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(2, Math.abs(openY - closeY));
    const bodyWidth = Math.max(7, Math.min(16, this.view.candleWidth * 2.2));
    const span = Math.max(8, Math.abs(lowY - highY));
    const rowCount = Math.max(3, Math.min(8, Math.floor(span / 8)));
    const rowHeight = span / rowCount;
    const volumeAlpha = Math.max(0.22, Math.min(0.92, Math.sqrt(c.volume / Math.max(1, maxVol))));

    g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: 1, color: bullish ? theme.silverBright : theme.redBright, alpha: 0.78 });
    g.rect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight)
      .fill({ color: bullish ? 0x111417 : 0x19080b, alpha: 0.34 })
      .stroke({ width: 0.8, color: bullish ? theme.silver : theme.red, alpha: 0.62 });

    for (let row = 0; row < rowCount; row++) {
      const y = highY + row * rowHeight + rowHeight * 0.2;
      const position = rowCount <= 1 ? 0.5 : row / (rowCount - 1);
      const wave = 0.58 + Math.abs(Math.sin(c.time * 0.00019 + row * 1.53)) * 0.42;
      const buyBias = bullish ? 0.55 + (1 - position) * 0.18 : 0.33 + (1 - position) * 0.14;
      const sellWidth = bodyWidth * (1 - buyBias) * wave;
      const buyWidth = bodyWidth * buyBias * wave;
      const h = Math.max(1, rowHeight * 0.48);

      g.rect(x - sellWidth, y, sellWidth, h).fill({ color: theme.redBright, alpha: 0.18 + volumeAlpha * 0.36 });
      g.rect(x, y, buyWidth, h).fill({ color: theme.green, alpha: 0.14 + volumeAlpha * 0.32 });
    }
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
      t.destroy();
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
    const t = new Text({
      text,
      style: {
        fontFamily: family,
        fontSize: size,
        fill: color,
        fontWeight: weight
      }
    });
    t.x = x;
    t.y = y;
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

    // right price scale
    this.addText(this.hudTexts, "USDT", plotWidth + 18, 11, 11, theme.text, "600", "Inter");

    for (let i = 0; i <= 10; i++) {
      const y = this.view.topPadding + ((plotHeight - this.view.topPadding) / 10) * i;
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

    for (const lvl of this.resolvedLiquidityLabelPositions(plotHeight)) {
      g.moveTo(plotWidth - 190, lvl.y).lineTo(plotWidth, lvl.y).stroke({ width: 1, color: lvl.labelColor, alpha: 0.18 });
      this.addText(this.labelTexts, lvl.label, plotWidth - 132, lvl.y - 13, 11, lvl.labelColor, "600", "Inter");
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

    const price = this.priceForY(this.pointer.y);
    g.rect(plotWidth + 4, this.pointer.y - 11, 64, 22).fill({ color: theme.red, alpha: 0.95 });
    this.addCrosshairText(price.toLocaleString(undefined, { maximumFractionDigits: 1 }), plotWidth + 8, this.pointer.y - 7);

    const timeLabel = this.timeLabelForX(this.pointer.x);
    g.rect(this.pointer.x - 54, plotHeight + 3, 108, 22).fill({ color: theme.red, alpha: 0.95 });
    this.addCrosshairText(timeLabel, this.pointer.x - 49, plotHeight + 7);
  }
}
