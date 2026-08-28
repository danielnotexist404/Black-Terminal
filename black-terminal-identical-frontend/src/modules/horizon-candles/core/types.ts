import type { Candle } from "../../../chart-engine/types";

export type HorizonLodMode = "auto" | "candles" | "clusters" | "wave";
export type HorizonResolvedLod = "candles" | "clusters" | "wave";
export type HorizonDataQuality = "native-trades" | "native-1s" | "synthetic-1s" | "degraded";

export type HorizonCandleMode = {
  enabled: boolean;
  sourceResolution: "1s";
  displayHorizonMs: number;
  horizonScale: number;
  lodMode: HorizonLodMode;
  showMicroCandles: boolean;
  showWaveEnvelope: boolean;
  showDirectionalPressure: boolean;
  showRejectionHeat: boolean;
  showDataQualityBadge: boolean;
  dataQuality: HorizonDataQuality;
};

export type HorizonBucket = {
  startIndex: number;
  endIndex: number;
  centerIndex: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  deltaAvailable: boolean;
  bodyPressure: number;
  upperRejection: number;
  lowerRejection: number;
  rejectionImbalance: number;
  centerline: number;
  upperEnvelope: number;
  lowerEnvelope: number;
  centerlineSlope: number;
  cvdSlope: number;
  acceptanceMigration: number;
  compressionExpansion: number;
  directionScore: number;
};

export type HorizonWaveProjection = {
  firstIndex: number;
  lastIndex: number;
  bucketSize: number;
  candlesPerPixel: number;
  lod: HorizonResolvedLod;
  sourceSampleCount: number;
  expectedSampleCount: number;
  coverageRatio: number;
  deltaCoverageRatio: number;
  buckets: HorizonBucket[];
  arrays: {
    centerline: Float64Array;
    upperEnvelope: Float64Array;
    lowerEnvelope: Float64Array;
    directionScore: Float32Array;
    bodyPressure: Float32Array;
    rejectionImbalance: Float32Array;
    compressionExpansion: Float32Array;
    volume: Float64Array;
    delta: Float64Array;
  };
};

export type HorizonCrosshairSample = {
  index: number;
  candle: Candle;
  bucket: HorizonBucket | null;
};
