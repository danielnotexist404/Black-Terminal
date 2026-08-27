import type { CvdOscillatorSettings } from "./types.ts";

export const DEFAULT_CVD_OSCILLATOR_SETTINGS: CvdOscillatorSettings = {
  schemaVersion: 1,
  modelVersion: "BC_CVD_OSC_V1",
  parametersMode: "Auto",
  useVolumeIntegration: false,
  lookback: 5000,
  fastLength: 34,
  slowLength: 55,
  fastMaType: "EMA",
  slowMaType: "EMA",
  showRawCvd: true,
  showClouds: true,
  cloudLength: 40,
  cloudDeviation: 0.55,
  fastWaveColor: "#f4f4f5",
  fastWaveWidth: 2,
  fastWaveIntensity: 100,
  slowWaveColor: "#c40024",
  slowWaveWidth: 2,
  slowWaveIntensity: 94,
  rawCvdColor: "#8d8d92",
  rawCvdIntensity: 38,
  cloudIntensity: 8,
  showStatusPanel: true,
  statusPanelWidth: 218,
  reserveRightGutter: true
};

const clamp = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
};

const color = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

export function migrateCvdOscillatorSettings(value?: Partial<CvdOscillatorSettings> | null): CvdOscillatorSettings {
  const next = { ...DEFAULT_CVD_OSCILLATOR_SETTINGS, ...(value ?? {}) };
  return {
    ...next,
    schemaVersion: 1,
    modelVersion: "BC_CVD_OSC_V1",
    parametersMode: next.parametersMode === "Custom" ? "Custom" : "Auto",
    useVolumeIntegration: Boolean(next.useVolumeIntegration),
    lookback: Math.round(clamp(next.lookback, 5000, 100, 20_000)),
    fastLength: Math.round(clamp(next.fastLength, 34, 2, 1000)),
    slowLength: Math.round(clamp(next.slowLength, 55, 3, 2000)),
    fastMaType: ["EMA", "SMA", "WMA", "RMA"].includes(next.fastMaType) ? next.fastMaType : "EMA",
    slowMaType: ["EMA", "SMA", "WMA", "RMA"].includes(next.slowMaType) ? next.slowMaType : "EMA",
    showRawCvd: Boolean(next.showRawCvd),
    showClouds: Boolean(next.showClouds),
    cloudLength: Math.round(clamp(next.cloudLength, 40, 5, 500)),
    cloudDeviation: clamp(next.cloudDeviation, 0.55, 0.05, 5),
    fastWaveColor: color(next.fastWaveColor, "#f4f4f5"),
    fastWaveWidth: clamp(next.fastWaveWidth, 2, 0.5, 5),
    fastWaveIntensity: clamp(next.fastWaveIntensity, 100, 0, 100),
    slowWaveColor: color(next.slowWaveColor, "#c40024"),
    slowWaveWidth: clamp(next.slowWaveWidth, 2, 0.5, 5),
    slowWaveIntensity: clamp(next.slowWaveIntensity, 94, 0, 100),
    rawCvdColor: color(next.rawCvdColor, "#8d8d92"),
    rawCvdIntensity: clamp(next.rawCvdIntensity, 38, 0, 100),
    cloudIntensity: clamp(next.cloudIntensity, 8, 0, 40),
    showStatusPanel: Boolean(next.showStatusPanel),
    statusPanelWidth: Math.round(clamp(next.statusPanelWidth, 218, 170, 300)),
    reserveRightGutter: Boolean(next.reserveRightGutter)
  };
}
