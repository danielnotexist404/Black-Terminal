import type { IndicatorAlertDefinition } from "../automation/alerts";
import type { ChartPriceTransformSnapshot } from "./priceTransform";
import type { KioseffSnapshot } from "../modules/kioseff-stop-loss-clustering/core/canonical";
import type { KioseffSettingsV1 } from "../modules/kioseff-stop-loss-clustering/core/settings";
import type { AuctionProfileSettings, AuctionProfileSnapshot } from "../modules/auction-profile/core/types";
import type { LiquidationFieldSettings } from "../modules/liquidation-field/core/types";
import type { BclifRendererMetrics } from "../modules/liquidation-field/rendering/BlackCoreLiquidationFieldRenderer";
import type { DDAProSettings, DDAProSnapshot } from "../modules/dda-pro/core/types";
import type { AcvdSettings, AcvdSnapshot } from "../modules/acvd/core/types";


export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ChartDisplayType =
  | "candlesticks"
  | "heikinAshi"
  | "volumeFootprint"
  | "renko"
  | "hollow"
  | "line";

export type DrawingToolId =
  | "cursor"
  | "trendLine"
  | "horizontalLine"
  | "verticalLine"
  | "fibonacci"
  | "rectangle"
  | "brush"
  | "eraser"
  | "text"
  | "measure";

export type ReplayCommand = "select" | "start" | "rewind" | "stop";

export type ReplayControls = {
  enabled: boolean;
  playing: boolean;
  selecting: boolean;
  speed: number;
  startPercent: number;
  selectedIndex?: number;
  command?: ReplayCommand;
  commandId: number;
};

export type ReplayStatus = {
  active: boolean;
  playing: boolean;
  selecting?: boolean;
  index: number;
  total: number;
  progress: number;
  time?: number;
  label?: string;
};

export type ReplaySelection = {
  index: number;
  time: number;
  price: number;
};

export type ChartTheme = {
  background: number;
  grid: number;
  gridAlpha: number;
  text: number;
  muted: number;
  red: number;
  redBright: number;
  orange: number;
  orangeBright: number;
  silver: number;
  silverBright: number;
  green: number;
};

export type ViewState = {
  width: number;
  height: number;
  rightAxisWidth: number;
  bottomAxisHeight: number;
  topPadding: number;
  bottomPadding: number;
  candleWidth: number;
  gap: number;
  scrollX: number;
  priceMin: number;
  priceMax: number;
  firstIndex: number;
  lastIndex: number;
};

export type ChartEngineOptions = {
  host: HTMLDivElement;
  candles: Candle[];
  chartType?: ChartDisplayType;
  snapToLatest?: boolean;
  visibleIndicators?: VisibleIndicators;
  indicatorPeriods?: IndicatorPeriods;
  indicatorVisualSettings?: IndicatorVisualSettings;
  indicatorAdvancedSettings?: IndicatorAdvancedSettings;
  kioseffSnapshot?: KioseffSnapshot | null;
  kioseffSettings?: KioseffSettingsV1;
  auctionProfileSnapshot?: AuctionProfileSnapshot | null;
  auctionProfileSnapshots?: AuctionProfileSnapshot[];
  auctionProfileSettings?: AuctionProfileSettings;
  ddaProSnapshot?: DDAProSnapshot | null;
  acvdSnapshot?: AcvdSnapshot | null;
  alertDefinitions?: IndicatorAlertDefinition[];
  customPlots?: any[];
  onAlertFired?: (symbol: string, message: string) => void;
  onAlertEditRequest?: (alertId: string) => void;
  onNeedMoreHistory?: (oldestCandle: Candle) => void;
  onPriceChange?: (price: number) => void;
  onCandleChange?: (candle: Candle) => void;
  onPriceTransformChange?: (transform: ChartPriceTransformSnapshot) => void;
  onLiquidationRendererMetrics?: (metrics: BclifRendererMetrics) => void;
  onFps?: (fps: number) => void;
  priceLineColor?: string;
  priceLineIntensity?: number;
};

export type VisibleIndicators = {
  qalc: boolean;
  liquidationHeatmap: boolean;
  auctionProfile: boolean;
  volatilityHeatmap: boolean;
  volumeProfile: boolean;
  aif: boolean;
  adaptiveSwingStrategy: boolean;
  vwap: boolean;
  ema20: boolean;
  ema50: boolean;
  ema200: boolean;
  sma20: boolean;
  sma50: boolean;
  bollinger: boolean;
  openInterestOscillator: boolean;
  zScoreOscillator: boolean;
  waveTrendOscillator: boolean;
  ddaProOscillator: boolean;
  acvdOscillator: boolean;
  volume: boolean;
};

export type IndicatorPeriods = {
  volatilityHeatmap: number;
  volumeProfile: number;
  ema20: number;
  ema50: number;
  ema200: number;
  sma20: number;
  sma50: number;
  bollinger: number;
  openInterestOscillator: number;
  zScoreOscillator: number;
  waveTrendOscillator: number;
  ddaProOscillator: number;
  acvdOscillator: number;
};

export type IndicatorColorKey = "red" | "white" | "silver" | "gray" | "green" | "orange";

export type IndicatorVisualSetting = {
  color: IndicatorColorKey;
  intensity: number;
};

export type IndicatorVisualSettings = {
  [Key in keyof VisibleIndicators]: IndicatorVisualSetting;
};

export type QalcIndicatorSettings = {
  schemaVersion: 1;
  modelVersion: "BC-QALC-BASELINE-1";
  displayMode: "LIVE" | "REPLAY" | "COMBINED";
  predictionHorizonMs: 250 | 500 | 1000 | 3000 | 5000 | 10000;
  minimumNetEdgeMultiplier: number;
  minimumFillProbability: number;
  maximumToxicity: number;
  quoteLifetimeMs: number;
  showCandidates: boolean;
  showRejected: boolean;
  showQuotes: boolean;
  showCancellations: boolean;
  showPartialFills: boolean;
  showEntries: boolean;
  showExits: boolean;
  showMicrostructurePane: boolean;
  markerSize: number;
  paneHeight: number;
  paneScale: number;
  paneOffset: number;
  longColor: string;
  shortColor: string;
  neutralColor: string;
  tooltipDetail: "COMPACT" | "FULL";
  selectedRunId: string;
};

export type VolumeProfileSettings = {
  showVolumeProfile: boolean;
  upVolumeColor: string;
  downVolumeColor: string;
  valueAreaUpColor: string;
  valueAreaDownColor: string;
  showSentimentProfile: boolean;
  sentimentBullishColor: string;
  sentimentBearishColor: string;
  showSupplyDemandZones: boolean;
  supplyDemandThreshold: number;
  supplyZoneColor: string;
  demandZoneColor: string;
  supplyDemandIntensity: number;
  showProfileGaps: boolean;
  nodeDetectionPercent: number;
  profileGapColor: string;
  profileGapIntensity: number;
  pocMode: "none" | "developing" | "lastLine";
  pocColor: string;
  pocWidth: number;
  valueAreaPercent: number;
  showVAH: boolean;
  vahColor: string;
  vahWidth: number;
  showVAL: boolean;
  valColor: string;
  valWidth: number;
  polarityMethod: "barPolarity" | "pressure";
  rangeMode: "fixed" | "visible";
  fixedRangeLength: number;
  fixedRangeResetToken: number;
  showProfileStats: boolean;
  statsSize: "Tiny" | "Small" | "Normal";
  statsPosition: "Top Right" | "Middle Right" | "Bottom Left";
  showPriceLevels: boolean;
  priceLabelSize: "Tiny" | "Small" | "Normal";
  placement: "right" | "left";
  rows: number;
  widthPercent: number;
  horizontalOffset: number;
  showValueAreaBackground: boolean;
  valueAreaBackgroundColor: string;
  showProfileBackground: boolean;
  profileBackgroundColor: string;
  hdlxOscillator: boolean;
  hdlxPriceSource: "close" | "hl2" | "hlc3" | "ohlc4";
  hdlxLookback: number;
  hdlxSmooth: number;
  hdlxPreset: "Custom" | "Default" | "Fast Response" | "Smooth Trend";
  hdlxExtreme: number;
  hdlxClamp: number;
  hdlxColorPreset: "Classic" | "Aqua" | "Cosmic" | "Ember" | "Neon" | "Custom";
  hdlxPositiveColor: string;
  hdlxNegativeColor: string;
  hdlxUseCustomLineColor: boolean;
  hdlxLineColor: string;
  hdlxLineWidth: number;
  hdlxFillTransparency: number;
  hdlxHeight: number;
  hdlxOffset: number;
  hdlxDrawLevels: boolean;
  hdlxShowBackground: boolean;
  hdlxBackgroundColor: string;
  hdlxEnableBarColoring: boolean;
  volumeWeightedBarColoring: boolean;
  volumeMaLength: number;
  upperThreshold: number;
  lowerThreshold: number;
  strongBarUpColor: string;
  strongBarDownColor: string;
  weakBarUpColor: string;
  weakBarDownColor: string;
};

export type AdaptiveSwingStrategySettings = {
  showSignals: boolean;
  showSignalLabels: boolean;
  showTakeProfits: boolean;
  showStopLosses: boolean;
  showRegimeEma: boolean;
  showSwingLevels: boolean;
  showChopFilter: boolean;
  markerSize: number;
  projectionBars: number;
  labelSize: "Tiny" | "Small" | "Normal";
  longColor: string;
  shortColor: string;
  takeProfitColor: string;
  stopLossColor: string;
  regimeEmaColor: string;
  swingLevelColor: string;
  swingLookback: number;
  atrLength: number;
  regimeEmaLength: number;
  rsiLength: number;
  rsiOversold: number;
  rsiOverbought: number;
  atrStopMultiplier: number;
  swingRetestAtr: number;
  stopLossPercent: number;
  takeProfitRatio: number;
  minTrendQuality: number;
  maxChopRatio: number;
  volumeLookback: number;
  minVolumeMultiplier: number;
  sessionStartHour?: number;
  sessionEndHour?: number;
  optimizationEnabled: boolean;
  optimizeSwingLookbackMin: number;
  optimizeSwingLookbackMax: number;
  optimizeSwingLookbackStep: number;
  optimizeAtrStopMin: number;
  optimizeAtrStopMax: number;
  optimizeAtrStopStep: number;
  optimizeTakeProfitMin: number;
  optimizeTakeProfitMax: number;
  optimizeTakeProfitStep: number;
  optimizeTrendQualityMin: number;
  optimizeTrendQualityMax: number;
  optimizeTrendQualityStep: number;
  robustnessMode: "Balanced" | "Profit First" | "Drawdown First";
};

export type OscillatorIndicatorKey =
  | "openInterestOscillator"
  | "zScoreOscillator"
  | "waveTrendOscillator"
  | "ddaProOscillator"
  | "acvdOscillator";

export type OscillatorPaneSettings = {
  height: number;
  paneHeights: Record<OscillatorIndicatorKey, number>;
  order: OscillatorIndicatorKey[];
  backgroundColor: string;
  backgroundIntensity: number;
  zeroLineColor: string;
  zeroLineIntensity: number;
};

export type WaveTrendOscillatorSettings = {
  injectIntoPrimary: boolean;
  mainLineWidth: number;
  signalLineWidth: number;
  signalColor: string;
  signalIntensity: number;
};

export type ZScoreOscillatorSettings = {
  source: "close" | "hl2" | "hlc3" | "ohlc4";
  calculationMethod: "price" | "logReturn" | "percentReturn" | "robust";
  basisMethod: "sma" | "ema";
  deviationMode: "population" | "sample";
  smoothingMethod: "none" | "sma" | "ema" | "rma";
  smoothingLength: number;
  upperBand: number;
  lowerBand: number;
  clamp: number;
  upperBandColor: string;
  lowerBandColor: string;
  midlineColor: string;
  lineWidth: number;
  lineIntensity: number;
  bandIntensity: number;
  showBandFill: boolean;
  bandFillIntensity: number;
};

export type VwapAnchorMode =
  | "session"
  | "week"
  | "month"
  | "fullHistory"
  | "rolling"
  | "swingHigh"
  | "swingLow"
  | "volumeClimax"
  | "volatilityBreak"
  | "autoRegime";

export type VwapWeightingModel =
  | "volume"
  | "time"
  | "exponentialVolume"
  | "liquidityAdjusted"
  | "volatilityParticipation"
  | "directionalConviction"
  | "blackCoreHybrid";

export type VwapSettings = {
  preset:
    | "Custom"
    | "Institutional Session"
    | "Rolling Execution"
    | "Liquidity Discovery"
    | "Event Shock"
    | "Black Core Adaptive";
  anchorMode: VwapAnchorMode;
  source: "close" | "hl2" | "hlc3" | "ohlc4" | "weightedClose";
  weightingModel: VwapWeightingModel;
  sessionAnchorHourUtc: number;
  lookbackBars: number;
  anchorLookbackBars: number;
  atrLength: number;
  decayHalfLife: number;
  directionalBias: number;
  regimeSensitivity: number;
  volumeThreshold: number;
  minimumBarsBetweenAnchors: number;
  smoothingMethod: "none" | "ema" | "rma";
  smoothingLength: number;
  bandMode: "weightedStd" | "atr" | "percentage" | "microstructure";
  bandPercentage: number;
  showBand1: boolean;
  showBand2: boolean;
  showBand3: boolean;
  band1Multiplier: number;
  band2Multiplier: number;
  band3Multiplier: number;
  band1Color: string;
  band2Color: string;
  band3Color: string;
  bandIntensity: number;
  showBandFill: boolean;
  bandFillColor: string;
  bandFillIntensity: number;
  lineWidth: number;
  useCustomLineColor: boolean;
  lineColor: string;
  dynamicSlopeColor: boolean;
  bullishColor: string;
  bearishColor: string;
  neutralColor: string;
  slopeLookback: number;
  slopeThresholdBps: number;
  showAnchorMarkers: boolean;
  anchorMarkerColor: string;
  showPreviousVwap: boolean;
  previousVwapColor: string;
  previousVwapIntensity: number;
};

export type IndicatorAdvancedSettings = {
  qalc: QalcIndicatorSettings;
  liquidationField: LiquidationFieldSettings;
  volumeProfile: VolumeProfileSettings;
  adaptiveSwingStrategy: AdaptiveSwingStrategySettings;
  oscillatorPane: OscillatorPaneSettings;
  zScoreOscillator: ZScoreOscillatorSettings;
  waveTrendOscillator: WaveTrendOscillatorSettings;
  ddaProOscillator: DDAProSettings;
  acvdOscillator: AcvdSettings;
  vwap: VwapSettings;
};

export type FeedEvent = {
  type: "alert";
  signal: string;
  price: number;
};
