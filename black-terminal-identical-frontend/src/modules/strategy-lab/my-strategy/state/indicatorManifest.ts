import type { IndicatorAlertDefinition } from "../../../../automation/alerts";
import type {
  IndicatorAdvancedSettings,
  IndicatorPeriods,
  VisibleIndicators,
} from "../../../../chart-engine/types";
import type { StrategyRuntimeKind } from "../../types/strategy.types";
import type { UserScript } from "../../../../scripts/userScriptLibrary";
import type {
  StrategyIndicatorAlert,
  StrategyIndicatorBinding,
} from "../../automation/strategyAutomation.types";

export type StrategyIndicatorInstance = StrategyIndicatorBinding & {
  source: "ACTIVE_CHART" | "CUSTOM" | "BUILT_IN";
  runtimeKind: StrategyRuntimeKind;
  settings: Record<string, unknown>;
};

type ManifestRow = {
  key: keyof VisibleIndicators;
  name: string;
  version: string;
  runtimeKind: StrategyRuntimeKind;
  runtimeStatus: StrategyIndicatorBinding["runtimeStatus"];
  warmup: number;
  alerts: StrategyIndicatorAlert[];
};

const longShortAlerts: StrategyIndicatorAlert[] = [
  { id: "long-entry", name: "Long Entry", description: "Confirmed bullish entry signal.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
  { id: "short-entry", name: "Short Entry", description: "Confirmed bearish entry signal.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
  { id: "long-exit", name: "Long Exit", description: "Optional confirmed long-position exit.", semantic: "LONG_EXIT", confirmedBar: true, intrabar: false },
  { id: "short-exit", name: "Short Exit", description: "Optional confirmed short-position exit.", semantic: "SHORT_EXIT", confirmedBar: true, intrabar: false },
];

const acvdAlerts: StrategyIndicatorAlert[] = [
  { id: "bc-acvd:long", name: "BC-ACVD Long", description: "Final closed-bar selling-exhaustion and lower-structure confirmation.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
  { id: "bc-acvd:short", name: "BC-ACVD Short", description: "Final closed-bar buying-exhaustion and upper-structure confirmation.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
];

const marketSentimentAlerts: StrategyIndicatorAlert[] = [
  { id: "bc-mso:adaptive-long", name: "Confirmed Adaptive Long", description: "A prior-bar-calibrated lower-tail extreme reverses with optional causal price-structure confirmation.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
  { id: "bc-mso:adaptive-short", name: "Confirmed Adaptive Short", description: "A prior-bar-calibrated upper-tail extreme reverses with optional causal price-structure confirmation.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
  { id: "bc-mso:enter-oversold", name: "Enter Oversold", description: "Composite sentiment crosses into the oversold band on a confirmed bar.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
  { id: "bc-mso:exit-oversold", name: "Exit Oversold", description: "Composite sentiment leaves the oversold band on a confirmed bar.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
  { id: "bc-mso:enter-overbought", name: "Enter Overbought", description: "Composite sentiment crosses into the overbought band on a confirmed bar.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
  { id: "bc-mso:exit-overbought", name: "Exit Overbought", description: "Composite sentiment leaves the overbought band on a confirmed bar.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
];

const qalcAlerts: StrategyIndicatorAlert[] = [
  { id: "qalc:candidate-long", name: "Candidate Long", description: "Canonical event-time BC-QALC passive-bid candidate.", semantic: "LONG_ENTRY", confirmedBar: false, intrabar: true },
  { id: "qalc:candidate-short", name: "Candidate Short", description: "Canonical event-time BC-QALC passive-ask candidate.", semantic: "SHORT_ENTRY", confirmedBar: false, intrabar: true },
  { id: "qalc:entry-long", name: "Paper Entry Long", description: "Canonical simulated queue fill opened long inventory.", semantic: "LONG_ENTRY", confirmedBar: false, intrabar: true },
  { id: "qalc:entry-short", name: "Paper Entry Short", description: "Canonical simulated queue fill opened short inventory.", semantic: "SHORT_ENTRY", confirmedBar: false, intrabar: true },
  { id: "qalc:exit-long", name: "Paper Exit Long", description: "Canonical BC-QALC long inventory exit.", semantic: "LONG_EXIT", confirmedBar: false, intrabar: true },
  { id: "qalc:exit-short", name: "Paper Exit Short", description: "Canonical BC-QALC short inventory exit.", semantic: "SHORT_EXIT", confirmedBar: false, intrabar: true },
];

const manifests: ManifestRow[] = [
  { key: "qalc", name: "BC-QALC — Queue-Aware Liquidity Capture", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 1_000, alerts: qalcAlerts },
  { key: "adaptiveSwingStrategy", name: "Adaptive Swing Reversal", version: "1", runtimeKind: "builtin-adaptive-swing", runtimeStatus: "CERTIFIED", warmup: 240, alerts: longShortAlerts },
  { key: "acvdOscillator", name: "BC-ACVD — Adaptive Causal Volume Delta", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 1_000, alerts: acvdAlerts },
  { key: "marketSentimentOscillator", name: "BC-MSO — Market Sentiment Oscillator", version: "2", runtimeKind: "python-script", runtimeStatus: "BROWSER_ONLY", warmup: 1200, alerts: marketSentimentAlerts },
  // BC-RDA is intentionally absent while BC_RDA_LEGACY_REPAINTING is under
  // forensic containment and BC_RDA_CAUSAL_V2 lacks a certified headless VPS
  // runtime. The chart indicator remains available as research visualization.
  { key: "vwap", name: "Institutional VWAP", version: "2", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 300, alerts: crossingAlerts("vwap") },
  { key: "ema20", name: "EMA 20", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 20, alerts: crossingAlerts("ema20") },
  { key: "ema50", name: "EMA 50", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 50, alerts: crossingAlerts("ema50") },
  { key: "ema200", name: "EMA 200", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 200, alerts: crossingAlerts("ema200") },
  { key: "auctionProfile", name: "RADAP", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 500, alerts: [] },
  { key: "volumeProfile", name: "HDLX Profile", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 500, alerts: [] },
  { key: "liquidationHeatmap", name: "Liquidation Intelligence", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 1_000, alerts: [] },
  { key: "volatilityHeatmap", name: "Market Maker Heatmap", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 1_000, alerts: [] },
  { key: "aif", name: "A.I.F. Auction Intelligence", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 1_000, alerts: [] },
  { key: "bollinger", name: "Bollinger Bands", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 50, alerts: crossingAlerts("bollinger") },
  { key: "openInterestOscillator", name: "Open Interest Oscillator", version: "1", runtimeKind: "python-script", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 100, alerts: [] },
  { key: "zScoreOscillator", name: "Z-Score Oscillator", version: "1", runtimeKind: "python-script", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 100, alerts: [] },
  { key: "waveTrendOscillator", name: "WaveTrend Oscillator", version: "1", runtimeKind: "python-script", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 100, alerts: [] },
];

export function buildActiveIndicatorInstances(input: {
  visible: VisibleIndicators;
  periods: IndicatorPeriods;
  advanced: IndicatorAdvancedSettings;
  configuredAlerts: IndicatorAlertDefinition[];
}): StrategyIndicatorInstance[] {
  return buildIndicatorInstances(input, true);
}

export function buildSelectableIndicatorInstances(input: {
  visible: VisibleIndicators;
  periods: IndicatorPeriods;
  advanced: IndicatorAdvancedSettings;
  configuredAlerts: IndicatorAlertDefinition[];
}): StrategyIndicatorInstance[] {
  return buildIndicatorInstances(input, false).filter((instance) => instance.alerts.length > 0);
}

function buildIndicatorInstances(input: {
  visible: VisibleIndicators;
  periods: IndicatorPeriods;
  advanced: IndicatorAdvancedSettings;
  configuredAlerts: IndicatorAlertDefinition[];
}, activeOnly: boolean): StrategyIndicatorInstance[] {
  return manifests
    .filter((manifest) => !activeOnly || input.visible[manifest.key])
    .map((manifest) => {
      const active = input.visible[manifest.key] === true;
      const settings = settingsFor(manifest.key, input.periods, input.advanced);
      const configured = input.configuredAlerts
        .filter((alert) => alert.enabled && alert.indicator === alertTargetFor(manifest.key))
        .map<StrategyIndicatorAlert>((alert) => ({
          id: `configured:${alert.id}`,
          name: alert.name,
          description: alert.message || "User-configured Black Terminal alert.",
          semantic: inferSemantic(alert.name),
          confirmedBar: true,
          intrabar: false,
        }));
      const alerts = uniqueAlerts([...manifest.alerts, ...configured]);
      const settingsHash = stableHash(settings);
      return {
        indicatorId: String(manifest.key),
        instanceId: `${active ? "chart" : "library"}:${String(manifest.key)}`,
        name: manifest.name,
        instanceName: `${manifest.name} — ${active ? "Active Chart Instance" : "Indicator Library"}`,
        version: manifest.version,
        settingsHash,
        settingsSummary: summarizeSettings(settings),
        alertManifestVersion: `${manifest.version}:${stableHash(alerts)}`,
        runtimeVersion: manifest.runtimeStatus === "CERTIFIED" ? "black-cloud-paper-v1" : "unavailable",
        warmupBars: manifest.warmup,
        runtimeStatus: manifest.runtimeStatus,
        useCurrentChartSettings: active,
        alerts,
        source: active ? "ACTIVE_CHART" : "BUILT_IN",
        runtimeKind: manifest.runtimeKind,
        settings,
      };
    });
}

export function ownedCustomIndicatorInstances(rows: readonly UserScript[]): StrategyIndicatorInstance[] {
  return rows.map<StrategyIndicatorInstance>((row) => {
      const sourceHash = stableHash(row.source);
      const alerts = parseCustomAlertManifest(row.source, row.kind === "strategy");
      const settings = row.inputValues ? { ...row.inputValues } : {};
      const label = row.kind === "strategy" ? "Owned Strategy" : "Owned Indicator";
      const certifiedSuperAtr = row.kind === "strategy" && isCertifiedSuperAtrSevenStepSource(row.source);
      return {
        indicatorId: `custom:${row.id}`,
        instanceId: `custom:${row.id}`,
        name: row.name,
        instanceName: `${row.name} — ${label}`,
        version: sourceHash,
        settingsHash: stableHash(settings),
        settingsSummary: Object.keys(settings).length
          ? `${summarizeSettings(settings)} · private ${row.kind}`
          : `Private ${row.kind} · Black Script v3`,
        alertManifestVersion: `custom:${stableHash(alerts)}`,
        runtimeVersion: certifiedSuperAtr ? "black-cloud-superatr-v1" : "black-script-v3-browser",
        warmupBars: 500,
        runtimeStatus: certifiedSuperAtr ? "CERTIFIED" as const : "REQUIRES_CERTIFICATION" as const,
        useCurrentChartSettings: false,
        alerts,
        source: "CUSTOM" as const,
        runtimeKind: certifiedSuperAtr ? "builtin-superatr-seven-step" as const : "python-script" as const,
        settings,
      };
    }).filter((instance) => instance.alerts.length > 0);
}

export function isCertifiedSuperAtrSevenStepSource(source: string) {
  const normalized = String(source || "").replace(/\s+/g, " ").toLowerCase();
  const required = [
    "superatr 7-step profit",
    "short_period",
    "long_period",
    "momentum_period",
    "adaptive_atr",
    "trend_strength",
    "usemultisteptp",
    "strategy.entry",
    "strategy.exit",
  ];
  return required.every((token) => normalized.includes(token))
    && /strategy\.entry\s*\([^)]*strategy\.long/i.test(source)
    && /strategy\.entry\s*\([^)]*strategy\.short/i.test(source)
    && (source.match(/strategy\.exit\s*\(/gi) || []).length >= 7;
}

function settingsFor(key: keyof VisibleIndicators, periods: IndicatorPeriods, advanced: IndicatorAdvancedSettings) {
  if (key === "qalc") return structuredClone(advanced.qalc) as unknown as Record<string, unknown>;
  if (key === "adaptiveSwingStrategy") return structuredClone(advanced.adaptiveSwingStrategy) as unknown as Record<string, unknown>;
  if (key === "ddaProOscillator") return structuredClone(advanced.ddaProOscillator) as unknown as Record<string, unknown>;
  if (key === "acvdOscillator") return structuredClone(advanced.acvdOscillator) as unknown as Record<string, unknown>;
  if (key === "marketSentimentOscillator") return structuredClone(advanced.marketSentimentOscillator) as unknown as Record<string, unknown>;
  if (key === "vwap") return structuredClone(advanced.vwap) as unknown as Record<string, unknown>;
  const period = periods[key as keyof IndicatorPeriods];
  return typeof period === "number" ? { period } : {};
}

function crossingAlerts(id: string): StrategyIndicatorAlert[] {
  return [
    { id: `${id}:cross-above`, name: "Price Crossing Above", description: "Price crosses above the indicator on a confirmed bar.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
    { id: `${id}:cross-below`, name: "Price Crossing Below", description: "Price crosses below the indicator on a confirmed bar.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
  ];
}

function alertTargetFor(key: keyof VisibleIndicators) {
  if (["vwap", "ema20", "ema50", "ema200"].includes(String(key))) return key as IndicatorAlertDefinition["indicator"];
  if (key === "volumeProfile") return "hdlxProfile";
  if (key === "ddaProOscillator") return "ddaPro";
  if (key === "acvdOscillator") return "acvd";
  if (key === "marketSentimentOscillator") return "marketSentiment";
  return "price";
}

function inferSemantic(name: string): StrategyIndicatorAlert["semantic"] {
  const normalized = name.toLowerCase();
  if (normalized.includes("short") || normalized.includes("sell") || normalized.includes("below")) return "SHORT_ENTRY";
  if (normalized.includes("long") || normalized.includes("buy") || normalized.includes("above")) return "LONG_ENTRY";
  return "NEUTRAL";
}

function parseCustomAlertManifest(source: string, strategyScript = false): StrategyIndicatorAlert[] {
  const rows: StrategyIndicatorAlert[] = [];
  for (const match of source.matchAll(/alertcondition\s*\([^,]+,\s*["']([^"']+)["']/gi)) {
    const name = match[1]?.trim();
    if (!name) continue;
    rows.push({ id: `custom-alert:${stableHash(name)}`, name, description: "Owned script alert; VPS certification is required before publish.", semantic: inferSemantic(name), confirmedBar: true, intrabar: false });
  }
  for (const match of source.matchAll(/\balert\s*\(\s*["']([^"']+)["']/gi)) {
    const name = match[1]?.trim();
    if (!name) continue;
    rows.push({ id: `custom-alert:${stableHash(name)}`, name, description: "Owned script alert; VPS certification is required before activation.", semantic: inferSemantic(name), confirmedBar: true, intrabar: false });
  }
  if (strategyScript) {
    for (const match of source.matchAll(/strategy\.entry\s*\(\s*["']([^"']+)["']\s*,\s*strategy\.(long|short)/gi)) {
      const name = match[1]?.trim();
      const direction = match[2]?.toLowerCase();
      if (!name || !direction) continue;
      rows.push({ id: `custom-entry:${stableHash(`${name}:${direction}`)}`, name, description: `Owned script ${direction} entry event; VPS certification is required before activation.`, semantic: direction === "long" ? "LONG_ENTRY" : "SHORT_ENTRY", confirmedBar: true, intrabar: false });
    }
    for (const match of source.matchAll(/strategy\.exit\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/gi)) {
      const name = match[1]?.trim();
      const fromEntry = match[2]?.trim();
      if (!name || !fromEntry) continue;
      const semantic = inferExitSemantic(`${name} ${fromEntry}`);
      rows.push({ id: `custom-exit:${stableHash(`${name}:${fromEntry}`)}`, name, description: `Owned script exit from ${fromEntry}; VPS certification is required before activation.`, semantic, confirmedBar: true, intrabar: false });
    }
    for (const match of source.matchAll(/strategy\.close\s*\(\s*["']([^"']+)["']/gi)) {
      const fromEntry = match[1]?.trim();
      if (!fromEntry) continue;
      rows.push({ id: `custom-close:${stableHash(fromEntry)}`, name: `Close ${fromEntry}`, description: `Owned script close event for ${fromEntry}; VPS certification is required before activation.`, semantic: inferExitSemantic(fromEntry), confirmedBar: true, intrabar: false });
    }
    if (/strategy\.close_all\s*\(/i.test(source)) {
      rows.push({ id: "custom-close-all", name: "Close All", description: "Owned script global close event; VPS certification is required before activation.", semantic: "NEUTRAL", confirmedBar: true, intrabar: false });
    }
  }
  return uniqueAlerts(rows);
}

function inferExitSemantic(name: string): StrategyIndicatorAlert["semantic"] {
  const normalized = name.toLowerCase();
  if (normalized.includes("short") || normalized.includes("sell")) return "SHORT_EXIT";
  if (normalized.includes("long") || normalized.includes("buy")) return "LONG_EXIT";
  return "NEUTRAL";
}

function uniqueAlerts(alerts: StrategyIndicatorAlert[]) {
  return [...new Map(alerts.map((alert) => [alert.id, alert])).values()];
}

function summarizeSettings(settings: Record<string, unknown>) {
  const rows = Object.entries(settings).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 4);
  return rows.length ? rows.map(([key, value]) => `${humanize(key)} ${String(value)}`).join(" · ") : "Current chart settings";
}

function humanize(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
}

export function stableHash(value: unknown) {
  const text = JSON.stringify(sortValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((output, key) => {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
    return output;
  }, {});
  return value;
}
