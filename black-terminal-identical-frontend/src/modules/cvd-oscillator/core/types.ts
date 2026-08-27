import type { Candle } from "../../../chart-engine/types";

export type CvdOscillatorMaType = "EMA" | "SMA" | "WMA" | "RMA";
export type CvdOscillatorMarketState = "LONG" | "SHORT" | "SIDEWAYS";

export type CvdOscillatorSettings = {
  schemaVersion: 1;
  modelVersion: "BC_CVD_OSC_V1";
  parametersMode: "Auto" | "Custom";
  useVolumeIntegration: boolean;
  lookback: number;
  fastLength: number;
  slowLength: number;
  fastMaType: CvdOscillatorMaType;
  slowMaType: CvdOscillatorMaType;
  showRawCvd: boolean;
  showClouds: boolean;
  cloudLength: number;
  cloudDeviation: number;
  fastWaveColor: string;
  fastWaveWidth: number;
  fastWaveIntensity: number;
  slowWaveColor: string;
  slowWaveWidth: number;
  slowWaveIntensity: number;
  rawCvdColor: string;
  rawCvdIntensity: number;
  cloudIntensity: number;
  showStatusPanel: boolean;
  statusPanelWidth: number;
  reserveRightGutter: boolean;
};

export type CvdOscillatorSnapshot = {
  authority: "OHLCV_CANDLE_SIGNED_ESTIMATE";
  modelVersion: "BC_CVD_OSC_V1";
  inputSize: number;
  validFrom: number;
  lengths: { fast: number; slow: number };
  series: {
    delta: number[];
    cvd: number[];
    fast: number[];
    slow: number[];
    upperCloud: number[];
    lowerCloud: number[];
    state: CvdOscillatorMarketState[];
  };
  latest: {
    state: CvdOscillatorMarketState;
    delta: number;
    cvd: number;
    fast: number;
    slow: number;
  };
};

export type CvdOscillatorInput = {
  candles: readonly Candle[];
  settings: CvdOscillatorSettings;
  timeframeSeconds: number;
};
