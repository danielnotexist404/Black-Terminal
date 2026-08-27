import assert from "node:assert/strict";
import { resolveOscillatorStack } from "../src/chart-engine/indicators/oscillatorLayout.ts";
import {
  defaultOscillatorPaneSettings,
  defaultWaveTrendOscillatorSettings
} from "../src/chart-engine/profile/volumeProfileDefaults.ts";
import type { VisibleIndicators } from "../src/chart-engine/types.ts";

const hidden: VisibleIndicators = {
  qalc: false,
  liquidationHeatmap: false,
  auctionProfile: false,
  volatilityHeatmap: false,
  volumeProfile: false,
  aif: false,
  adaptiveSwingStrategy: false,
  vwap: false,
  ema20: false,
  ema50: false,
  ema200: false,
  sma20: false,
  sma50: false,
  bollinger: false,
  openInterestOscillator: false,
  zScoreOscillator: false,
  waveTrendOscillator: false,
  ddaProOscillator: false,
  acvdOscillator: false,
  volume: false
};

const acvdStandalone = resolveOscillatorStack(
  { ...hidden, acvdOscillator: true },
  defaultOscillatorPaneSettings,
  defaultWaveTrendOscillatorSettings,
  900
);
assert.deepEqual(acvdStandalone.panes.map((pane) => pane.key), ["acvdOscillator"]);
assert.equal(acvdStandalone.panes[0]?.height, 176);

const ddaStandalone = resolveOscillatorStack(
  { ...hidden, ddaProOscillator: true },
  defaultOscillatorPaneSettings,
  defaultWaveTrendOscillatorSettings,
  900
);
assert.deepEqual(ddaStandalone.panes.map((pane) => pane.key), ["ddaProOscillator"]);
assert.equal(ddaStandalone.panes[0]?.height, 176);

const standalone = resolveOscillatorStack(
  { ...hidden, zScoreOscillator: true },
  defaultOscillatorPaneSettings,
  defaultWaveTrendOscillatorSettings,
  900
);
assert.deepEqual(standalone.panes.map((pane) => pane.key), ["zScoreOscillator"]);
assert.equal(standalone.panes[0]?.height, 128);

const stacked = resolveOscillatorStack(
  { ...hidden, zScoreOscillator: true, waveTrendOscillator: true },
  {
    ...defaultOscillatorPaneSettings,
    order: ["zScoreOscillator", "waveTrendOscillator"],
    paneHeights: {
      ...defaultOscillatorPaneSettings.paneHeights,
      zScoreOscillator: 150,
      waveTrendOscillator: 110
    }
  },
  defaultWaveTrendOscillatorSettings,
  900
);
assert.deepEqual(stacked.panes.map((pane) => pane.key), ["zScoreOscillator", "waveTrendOscillator"]);
assert.equal(stacked.panes[0]?.bottomOffset, 0, "first loaded oscillator remains the bottom/main pane");
assert.equal(stacked.panes[1]?.bottomOffset, 158, "new oscillator is stacked above with a fixed visual gap");
assert.equal(stacked.reservedHeight, 288);

const injected = resolveOscillatorStack(
  { ...hidden, zScoreOscillator: true, waveTrendOscillator: true },
  { ...defaultOscillatorPaneSettings, order: ["zScoreOscillator", "waveTrendOscillator"] },
  { ...defaultWaveTrendOscillatorSettings, injectIntoPrimary: true },
  900
);
assert.deepEqual(injected.panes.map((pane) => pane.key), ["zScoreOscillator"]);
assert.equal(injected.injectionTarget, "zScoreOscillator");
assert.ok(injected.reservedHeight < stacked.reservedHeight, "injection releases WaveTrend's separate pane");

const restored = resolveOscillatorStack(
  { ...hidden, zScoreOscillator: true, waveTrendOscillator: true },
  { ...defaultOscillatorPaneSettings, order: ["zScoreOscillator", "waveTrendOscillator"] },
  { ...defaultWaveTrendOscillatorSettings, injectIntoPrimary: false },
  900
);
assert.deepEqual(restored.panes.map((pane) => pane.key), ["zScoreOscillator", "waveTrendOscillator"]);

const firstLoadedOi = resolveOscillatorStack(
  { ...hidden, openInterestOscillator: true, zScoreOscillator: true, waveTrendOscillator: true },
  {
    ...defaultOscillatorPaneSettings,
    order: ["openInterestOscillator", "zScoreOscillator", "waveTrendOscillator"]
  },
  { ...defaultWaveTrendOscillatorSettings, injectIntoPrimary: true },
  900
);
assert.equal(firstLoadedOi.injectionTarget, "openInterestOscillator");
assert.deepEqual(firstLoadedOi.panes.map((pane) => pane.key), ["openInterestOscillator", "zScoreOscillator"]);

const waveOnly = resolveOscillatorStack(
  { ...hidden, waveTrendOscillator: true },
  { ...defaultOscillatorPaneSettings, order: ["waveTrendOscillator"] },
  { ...defaultWaveTrendOscillatorSettings, injectIntoPrimary: true },
  900
);
assert.equal(waveOnly.injectionTarget, undefined, "WaveTrend keeps a pane when no primary oscillator exists");
assert.deepEqual(waveOnly.panes.map((pane) => pane.key), ["waveTrendOscillator"]);

const customOnly = resolveOscillatorStack(
  hidden,
  defaultOscillatorPaneSettings,
  defaultWaveTrendOscillatorSettings,
  900,
  58,
  38,
  ["saved-cvd"]
);
assert.equal(customOnly.panes.length, 0);
assert.deepEqual(customOnly.customPanes.map((pane) => pane.scriptId), ["saved-cvd"]);
assert.equal(customOnly.customPanes[0]?.height, 170, "custom oscillators receive the platform default pane height");
assert.equal(customOnly.reservedHeight, 190, "the custom pane and its padding reserve price-chart space exactly once");

const resizedCustom = resolveOscillatorStack(
  { ...hidden, zScoreOscillator: true },
  {
    ...defaultOscillatorPaneSettings,
    customPaneHeights: { "saved-cvd": 286 }
  },
  defaultWaveTrendOscillatorSettings,
  900,
  58,
  38,
  ["saved-cvd"]
);
assert.equal(resizedCustom.panes[0]?.bottomOffset, 0);
assert.equal(resizedCustom.customPanes[0]?.bottomOffset, 136, "custom panes stack above native panes with the shared gap");
assert.equal(resizedCustom.customPanes[0]?.height, 286, "each saved oscillator uses its persisted custom height");
assert.equal(resizedCustom.reservedHeight, 442);

const independentCustomPanes = resolveOscillatorStack(
  hidden,
  {
    ...defaultOscillatorPaneSettings,
    customPaneHeights: { "saved-cvd": 210, "saved-sentiment": 120 }
  },
  defaultWaveTrendOscillatorSettings,
  900,
  58,
  38,
  ["saved-cvd", "saved-sentiment", "saved-cvd"]
);
assert.deepEqual(independentCustomPanes.customPanes.map((pane) => pane.height), [210, 120]);
assert.equal(independentCustomPanes.customPanes[1]?.bottomOffset, 218, "custom scripts retain independent pane boundaries");

const compact = resolveOscillatorStack(
  { ...hidden, openInterestOscillator: true, zScoreOscillator: true, waveTrendOscillator: true },
  {
    ...defaultOscillatorPaneSettings,
    order: ["zScoreOscillator", "openInterestOscillator", "waveTrendOscillator"],
    paneHeights: {
      openInterestOscillator: 420,
      zScoreOscillator: 420,
      waveTrendOscillator: 420
    }
  },
  defaultWaveTrendOscillatorSettings,
  520
);
assert.ok(compact.panes.every((pane) => pane.height >= 64), "compact view preserves usable pane height");
assert.ok(compact.totalContentHeight <= 340, "compact view scales the stack to preserve the price chart");

console.log("Oscillator pane stack and WaveTrend injection tests passed.");
