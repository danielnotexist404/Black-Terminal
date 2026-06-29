import type { ScanConfig, ScannerConditionGroup, ScannerRule } from "../types/scanner.types";

const now = 0;

function rule(
  id: string,
  label: string,
  patch: Omit<ScannerRule, "id" | "label">
): ScannerRule {
  return { id, label, ...patch };
}

function and(id: string, rules: ScannerConditionGroup["rules"]): ScannerConditionGroup {
  return { id, type: "AND", rules };
}

function basePreset(id: string, name: string, description: string, rules: ScannerRule[], notes?: string[]): ScanConfig {
  return {
    id,
    name,
    description,
    readOnly: true,
    universe: { type: "all-symbols" },
    timeframes: ["1h"],
    refreshMode: "manual",
    refreshIntervalSeconds: 60,
    maxResults: 100,
    sortBy: "score",
    sortDirection: "desc",
    conditions: and(`${id}-conditions`, rules),
    scoring: { enabled: true },
    createdAt: now,
    updatedAt: now,
    notes
  };
}

export const builtInScannerPresets: ScanConfig[] = [
  basePreset("preset-strong-uptrend", "Strong Uptrend", "Trend alignment with healthy RSI and volume confirmation.", [
    rule("close-gt-ema200", "Close above EMA 200", {
      left: { type: "price", field: "close" },
      operator: ">",
      right: { type: "indicator", name: "EMA", params: { period: 200 } }
    }),
    rule("close-gt-ema50", "Close above EMA 50", {
      left: { type: "price", field: "close" },
      operator: ">",
      right: { type: "indicator", name: "EMA", params: { period: 50 } }
    }),
    rule("ema50-gt-ema200", "EMA 50 above EMA 200", {
      left: { type: "indicator", name: "EMA", params: { period: 50 } },
      operator: ">",
      right: { type: "indicator", name: "EMA", params: { period: 200 } }
    }),
    rule("rsi-trend-zone", "RSI 14 between 50 and 70", {
      left: { type: "indicator", name: "RSI", params: { period: 14 } },
      operator: "between",
      right: { type: "constant", value: 50 },
      right2: { type: "constant", value: 70 }
    }),
    rule("volume-above-sma20", "Volume above volume SMA 20", {
      left: { type: "price", field: "volume" },
      operator: ">",
      right: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } }
    })
  ]),
  basePreset("preset-breakout-volume", "Breakout With Volume", "Breakout above prior range with volume and range expansion.", [
    rule("close-cross-high20", "Close crosses above highest high 20", {
      left: { type: "price", field: "close" },
      operator: "crosses_above",
      right: { type: "indicator", name: "HIGHEST_HIGH", params: { period: 20, includeCurrent: false } }
    }),
    rule("volume-150-sma20", "Volume above 1.5x volume SMA 20", {
      left: { type: "price", field: "volume" },
      operator: "percent_above",
      tolerance: 50,
      right: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } }
    }),
    rule("range-above-atr", "Current range above ATR 14", {
      left: { type: "price", field: "range" },
      operator: ">",
      right: { type: "indicator", name: "ATR", params: { period: 14 } }
    })
  ]),
  basePreset("preset-oversold-bounce", "Oversold Bounce Candidate", "RSI reclaim with price and volume confirmation.", [
    rule("rsi-cross-30", "RSI 14 crosses above 30", {
      left: { type: "indicator", name: "RSI", params: { period: 14 } },
      operator: "crosses_above",
      right: { type: "constant", value: 30 }
    }),
    rule("close-above-prev", "Close above previous close", {
      left: { type: "price", field: "close" },
      operator: ">",
      right: { type: "previous", field: "close" }
    }),
    rule("bounce-volume", "Volume above volume SMA 20", {
      left: { type: "price", field: "volume" },
      operator: ">",
      right: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } }
    }),
    rule("above-low5", "Close above lowest low 5", {
      left: { type: "price", field: "close" },
      operator: ">",
      right: { type: "indicator", name: "LOWEST_LOW", params: { period: 5, includeCurrent: false } }
    })
  ]),
  basePreset("preset-bearish-breakdown", "Bearish Breakdown", "Downside range break with volume and trend confirmation.", [
    rule("close-cross-low20", "Close crosses below lowest low 20", {
      left: { type: "price", field: "close" },
      operator: "crosses_below",
      right: { type: "indicator", name: "LOWEST_LOW", params: { period: 20, includeCurrent: false } }
    }),
    rule("close-below-ema50", "Close below EMA 50", {
      left: { type: "price", field: "close" },
      operator: "<",
      right: { type: "indicator", name: "EMA", params: { period: 50 } }
    }),
    rule("breakdown-volume", "Volume above 1.5x volume SMA 20", {
      left: { type: "price", field: "volume" },
      operator: "percent_above",
      tolerance: 50,
      right: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } }
    })
  ]),
  basePreset("preset-vol-expansion", "Volatility Expansion", "ATR and candle range expansion with volume confirmation.", [
    rule("atr-above-atr-sma", "ATR 14 above ATR SMA 20", {
      left: { type: "indicator", name: "ATR", params: { period: 14 } },
      operator: ">",
      right: { type: "indicator", name: "ATR_SMA", params: { atrPeriod: 14, period: 20 } }
    }),
    rule("range-150-atr", "Candle range above 1.5x ATR 14", {
      left: { type: "price", field: "range" },
      operator: "percent_above",
      tolerance: 50,
      right: { type: "indicator", name: "ATR", params: { period: 14 } }
    }),
    rule("vol-exp-volume", "Volume above volume SMA 20", {
      left: { type: "price", field: "volume" },
      operator: ">",
      right: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } }
    })
  ]),
  basePreset("preset-rs-leaders", "Relative Strength Leaders", "Strong trend with positive 20-period rate of change. Benchmark comparison is disabled until benchmark feeds are added.", [
    rule("rs-close-ema50", "Close above EMA 50", {
      left: { type: "price", field: "close" },
      operator: ">",
      right: { type: "indicator", name: "EMA", params: { period: 50 } }
    }),
    rule("rs-close-ema200", "Close above EMA 200", {
      left: { type: "price", field: "close" },
      operator: ">",
      right: { type: "indicator", name: "EMA", params: { period: 200 } }
    }),
    rule("rs-roc-positive", "20-period ROC positive", {
      left: { type: "indicator", name: "ROC", params: { period: 20 } },
      operator: ">",
      right: { type: "constant", value: 0 },
      note: "Benchmark-relative comparison is disabled until index/benchmark data is connected."
    }),
    rule("rs-volume", "Volume above volume SMA 20", {
      left: { type: "price", field: "volume" },
      operator: ">",
      right: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } }
    })
  ], ["Benchmark comparison is not connected yet; ROC is compared against zero as a temporary internal proxy."])
];

export function getBuiltInPresets() {
  return builtInScannerPresets.map((preset) => ({ ...preset, conditions: structuredClone(preset.conditions) }));
}
