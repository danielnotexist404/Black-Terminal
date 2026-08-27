import type { Candle } from "../../../chart-engine/types";

export type MarketSentimentZone = "OVERSOLD" | "NEUTRAL" | "OVERBOUGHT" | "INSUFFICIENT";

export type MarketSentimentCalculationMode = "ORIGINAL_COMPOSITE" | "REGIME_PERCENTILE" | "ADAPTIVE_EVT";

export type MarketSentimentRegime = "UPTREND" | "DOWNTREND" | "ROTATION" | "INSUFFICIENT";

export type MarketSentimentAlertEvent =
  | "ENTER_OVERBOUGHT"
  | "EXIT_OVERBOUGHT"
  | "ENTER_OVERSOLD"
  | "EXIT_OVERSOLD"
  | "CONFIRMED_ADAPTIVE_LONG"
  | "CONFIRMED_ADAPTIVE_SHORT";

export type MarketSentimentAlertSelection = MarketSentimentAlertEvent | "ANY_BAND_EVENT" | "ANY_ADAPTIVE_SIGNAL";

export type MarketSentimentSettings = {
  schemaVersion: 2;
  modelVersion: "BC-MSO-PYTHON-V2";
  lookback: number;
  calculationMode: MarketSentimentCalculationMode;
  candleView: boolean;
  candleTransform: number;
  heikinAshi: boolean;
  smoothingEnabled: boolean;
  smoothingLength: number;
  overbought: number;
  oversold: number;
  bullishColor: string;
  bearishColor: string;
  neutralColor: string;
  lineColor: string;
  candleIntensity: number;
  lineIntensity: number;
  lineWidth: number;
  bandIntensity: number;
  showBandFill: boolean;
  bandFillIntensity: number;
  adaptiveWindow: number;
  minimumCalibrationSamples: number;
  tailConfidence: number;
  evtThresholdPercentile: number;
  evtMinimumTailSamples: number;
  atrLength: number;
  regimeLength: number;
  regimeSlopeLength: number;
  regimeThreshold: number;
  trendExpansion: number;
  minimumTailDwell: number;
  structureLength: number;
  requireStructureConfirmation: boolean;
  signalCooldownBars: number;
  showRawComposite: boolean;
  showDynamicBands: boolean;
};

export type MarketSentimentEvent = {
  index: number;
  time: number;
  score: number;
  kind: MarketSentimentAlertEvent;
  threshold: number;
  regime: MarketSentimentRegime;
  tailProbability: number | null;
};

export type MarketSentimentComponents = {
  heikinAshi: Array<number | null>;
  emaVelocity: Array<number | null>;
  emaRegime: Array<number | null>;
  smaRegime: Array<number | null>;
  rsi: Array<number | null>;
  macd: Array<number | null>;
  histogram: Array<number | null>;
  stochastic: Array<number | null>;
  ma200: Array<number | null>;
  mfi: Array<number | null>;
  cci: Array<number | null>;
};

export type MarketSentimentSnapshot = {
  schemaVersion: 2;
  modelVersion: "BC-MSO-PYTHON-V2";
  authority: "CAUSAL_OHLCV_COMPOSITE" | "CAUSAL_REGIME_PERCENTILE" | "CAUSAL_REGIME_EVT";
  inputSize: number;
  sourceOffset: number;
  settings: MarketSentimentSettings;
  series: {
    rawSentiment: Array<number | null>;
    latentSentiment: Array<number | null>;
    empiricalPercentile: Array<number | null>;
    sentiment: Array<number | null>;
    dynamicUpper: Array<number | null>;
    dynamicLower: Array<number | null>;
    tailProbability: Array<number | null>;
    calibrationSamples: number[];
    evtActive: boolean[];
    regime: MarketSentimentRegime[];
    regimeStrength: number[];
    candleOpen: Array<number | null>;
    candleHigh: Array<number | null>;
    candleLow: Array<number | null>;
    candleClose: Array<number | null>;
    candleDirection: Array<-1 | 0 | 1>;
  };
  components: MarketSentimentComponents;
  events: MarketSentimentEvent[];
  latest: {
    score: number | null;
    rawScore: number | null;
    latentScore: number | null;
    zone: MarketSentimentZone;
    regime: MarketSentimentRegime;
    regimeStrength: number;
    dynamicUpper: number | null;
    dynamicLower: number | null;
    tailProbability: number | null;
    calibrationSamples: number;
    evtActive: boolean;
  };
  integrity: {
    causal: true;
    finalizedBarEventsOnly: true;
    futureBarsConsumed: 0;
    priorBarsOnlyCalibration: true;
    historicalValuesFrozen: true;
  };
};

export type MarketSentimentInput = {
  candles: Candle[];
  settings?: Partial<MarketSentimentSettings>;
  lastBarConfirmed?: boolean;
};
