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
  volume: false
};

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
