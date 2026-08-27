import type { Candle } from "../../../chart-engine/types";

export type MarketSentimentZone = "OVERSOLD" | "NEUTRAL" | "OVERBOUGHT" | "INSUFFICIENT";

export type MarketSentimentAlertEvent =
  | "ENTER_OVERBOUGHT"
  | "EXIT_OVERBOUGHT"
  | "ENTER_OVERSOLD"
  | "EXIT_OVERSOLD";

export type MarketSentimentAlertSelection = MarketSentimentAlertEvent | "ANY_BAND_EVENT";

export type MarketSentimentSettings = {
  schemaVersion: 1;
  modelVersion: "BC-MSO-PYTHON-V1";
  lookback: number;
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
};

export type MarketSentimentEvent = {
  index: number;
  time: number;
  score: number;
  kind: MarketSentimentAlertEvent;
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
  schemaVersion: 1;
  modelVersion: "BC-MSO-PYTHON-V1";
  authority: "CAUSAL_OHLCV_COMPOSITE";
  inputSize: number;
  sourceOffset: number;
  settings: MarketSentimentSettings;
  series: {
    rawSentiment: Array<number | null>;
    sentiment: Array<number | null>;
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
    zone: MarketSentimentZone;
  };
  integrity: {
    causal: true;
    finalizedBarEventsOnly: true;
    futureBarsConsumed: 0;
  };
};

export type MarketSentimentInput = {
  candles: Candle[];
  settings?: Partial<MarketSentimentSettings>;
  lastBarConfirmed?: boolean;
};
